import { BrowserWindow, desktopCapturer, globalShortcut, screen } from 'electron'
import type { Point, Size } from './geometry'
import type {
  FreezeFrame,
  FreezeLogger,
  FreezeWindowFactory,
  OverlayWindowHandle,
} from './controller'
import type { ShortcutRegistrar } from './shortcuts'
import { freezeWindowOptions } from './window-options'

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

      window.webContents.once('did-finish-load', () => {
        if (window.isDestroyed()) {
          return
        }
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
