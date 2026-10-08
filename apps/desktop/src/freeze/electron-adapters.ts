import { BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron'
import type { Point, Rect, Size } from './geometry'
import type {
  FreezeFrame,
  FreezeLogger,
  FreezeWindowFactory,
  OverlayWindowHandle,
  SelectionSource,
} from './controller'
import type { ShortcutRegistrar } from './shortcuts'
import { freezeWindowOptions } from './window-options'
import type { Candidate } from '../highlight/candidates'

/**
 * Electron 运行时绑定层：把纯逻辑控制器需要的四类能力（取屏、截屏、建窗、快捷键）
 * 接到真实 Electron API 上。这一层不写业务判断，只做类型适配与平台细节兜底，
 * 因此不进单测（纯逻辑已在控制器与几何层覆盖），由真链路 smoke 兜住。
 */

export function electronShortcutRegistrar(): ShortcutRegistrar {
  return {
    register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
    unregister: (accelerator) => {
      globalShortcut.unregister(accelerator)
    },
    isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
  }
}

/** 当前全部显示器的几何投影，保留负坐标副屏。 */
export function listDisplays() {
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    scaleFactor: display.scaleFactor,
  }))
}

/** 光标所在全局 DIP 坐标，用于决定进入冻结时聚焦哪块屏。 */
export function pointOfInterest(): Point {
  return screen.getCursorScreenPoint()
}

/**
 * 逐屏抓取静态位图。thumbnailSize 由几何层按物理像素规划后传入，保证各屏不低于原生分辨率。
 * display_id 为空串的是镜像/聚合源，无法定位到具体屏，直接丢弃。
 */
export async function captureFrames(thumbnailSize: Size): Promise<FreezeFrame[]> {
  let sources: Electron.DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`截屏失败：无法枚举屏幕源（${reason}）`, { cause: error })
  }
  return sources
    .filter((source) => source.display_id !== '')
    .map((source) => {
      const size = source.thumbnail.getSize()
      return {
        id: source.id,
        displayId: source.display_id,
        size: size.width > 0 && size.height > 0 ? size : null,
        dataUrl: source.thumbnail.toDataURL(),
      }
    })
}

/** 判断值是不是一个几何矩形；读取面是跨进程边界，拿到的东西先验形状再用。 */
function isRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (['x', 'y', 'width', 'height'] as const).every((key) => Number.isFinite(candidate[key]))
}

/**
 * 从覆盖窗渲染层读回当前锁定的选区（显示器相对 DIP）。
 *
 * 未锁定与页面尚未就绪都返回 null，两者的处置相同（按没有锁定处理），区分只会给调用方
 * 多一个无从判断的分支。查询本身失败（页面崩了、注入原语被移除）不吞：那是覆盖层出了故障，
 * 静默按「没有锁定」处理会把它变成一次莫名其妙的整屏拷贝。
 */
export async function readLockedRegion(window: BrowserWindow): Promise<Rect | null> {
  if (window.isDestroyed()) {
    return null
  }
  const value: unknown = await window.webContents.executeJavaScript(
    'typeof window.__treenGetLocked === "function" ? window.__treenGetLocked() : null',
  )
  return isRect(value) ? value : null
}

/**
 * 覆盖窗工厂，一屏一窗。
 *
 * 显示时机：截图经 executeJavaScript 注入后才 showInactive，避免先闪一块空白再被覆盖。
 * 用 showInactive 而非 show 是为了不在「多窗依次完成加载」时发生焦点互抢——真正需要键盘焦点
 * 的那块屏由控制器的 focus() 显式指定，见下。
 */
export function createOverlayWindowFactory(
  overlayPath: string,
  logger?: FreezeLogger,
): FreezeWindowFactory {
  let sequence = 0
  return {
    create(display, frame): OverlayWindowHandle {
      const window = new BrowserWindow(freezeWindowOptions(display))
      const id = ++sequence
      // 覆盖到全屏应用与所有工作区之上，否则别的应用进入全屏时空不出这块屏。
      window.setAlwaysOnTop(true, 'screen-saver')
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      // 帧以 data URL 走一次字符串 IPC，大屏下体积可观，记一行便于观测冻结进入耗时。
      logger?.info(
        `覆盖窗 display=${display.id} 帧 ${(frame.dataUrl.length / 1024 / 1024).toFixed(2)}MB`,
      )

      // 候选区域由控制器后台算好后送来，抵达时机可能早于 overlay.html 就绪（页面的注入原语
      // 尚未定义），故先暂存，待加载完成再投递；后到的覆盖先到的，只保留最新一份。
      let loaded = false
      let pendingCandidates: readonly Candidate[] | null = null

      function injectCandidates(): void {
        if (!loaded || pendingCandidates === null || window.isDestroyed()) {
          return
        }
        const payload = JSON.stringify(pendingCandidates)
        pendingCandidates = null
        void window.webContents
          .executeJavaScript(`window.__treenSetCandidates(${payload})`)
          .catch((error: unknown) => {
            logger?.warn(
              `候选区域注入失败：${error instanceof Error ? error.message : String(error)}`,
            )
          })
      }

      window.webContents.once('did-finish-load', () => {
        if (window.isDestroyed()) {
          return
        }
        loaded = true
        void window.webContents
          .executeJavaScript(`window.__treenSetFrame(${JSON.stringify(frame.dataUrl)})`)
          .catch((error: unknown) => {
            // 注入失败时仍显示窗口：宁可露出空白覆盖层，也不要留下「快捷键按下却毫无反应」的哑状态，
            // 用户至少能按 Escape 退出。失败本身仍要出声，否则这个降级态会一直静默。
            logger?.warn(`帧注入失败：${error instanceof Error ? error.message : String(error)}`)
          })
          .finally(() => {
            if (!window.isDestroyed()) {
              window.showInactive()
            }
          })
        injectCandidates()
      })
      void window.loadFile(overlayPath).catch((error: unknown) => {
        // 窗口在加载途中被 destroy（瞬时退出）时 rejection 属预期噪音，只在窗口仍活着时告警。
        if (!window.isDestroyed()) {
          logger?.warn(`overlay.html 加载失败：${error instanceof Error ? error.message : String(error)}`)
        }
      })

      return {
        id,
        displayId: display.id,
        setCandidates: (candidates) => {
          if (window.isDestroyed()) {
            return
          }
          pendingCandidates = candidates
          injectCandidates()
        },
        readSelection: async (): Promise<SelectionSource | null> => {
          const locked = await readLockedRegion(window)
          // 等渲染层答复期间窗口可能已被拆掉（用户按了 Escape），此时这一屏已无意义。
          return window.isDestroyed() ? null : { display, frame, locked }
        },
        focus: () => {
          if (window.isDestroyed()) {
            return
          }
          if (window.isVisible()) {
            window.focus()
          } else {
            // 窗口尚未 show：延到 show 后再聚焦，避免与「加载完成的窗口 showInactive」错序。
            window.once('show', () => {
              if (!window.isDestroyed()) {
                window.focus()
              }
            })
          }
        },
        close: () => {
          if (!window.isDestroyed()) {
            window.destroy()
          }
        },
        isDestroyed: () => window.isDestroyed(),
      }
    },
  }
}
