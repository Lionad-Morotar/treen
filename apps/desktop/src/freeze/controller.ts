import {
  captureThumbnailSize,
  displayContainingPoint,
  matchSourcesToDisplays,
  type CaptureSourceLike,
  type DisplayLike,
  type Point,
  type Size,
} from './geometry'
import { DEFAULT_FREEZE_ACCELERATOR, FREEZE_EXIT_ACCELERATOR } from './window-options'
import type { ShortcutManager } from './shortcuts'

/**
 * 冻结态编排：进入时截屏、逐屏建覆盖窗；退出时无条件拆掉全部窗口与快捷键。
 *
 * 所有 Electron 能力都经依赖注入（取屏、截屏、建窗、快捷键），控制器本身只在纯逻辑层
 * 运转，因而可在 Node 下被单测覆盖。真实 Electron 绑定在适配层提供。
 *
 * 生命周期不变量：任何失败路径都不得留下置顶透明窗或残留的全局快捷键——否则冻结窗会变成
 * 一块吞掉全屏点击的隐形层，用户无法自行恢复。
 */

/** 截屏帧：在通用源投影之上带渲染层可用的位图数据。 */
export interface FreezeFrame extends CaptureSourceLike {
  /** data URL，渲染层直接作为 img.src */
  dataUrl: string
}

/** 覆盖窗句柄：控制器只依赖这几个动作，不耦合 BrowserWindow 具体类型。 */
export interface OverlayWindowHandle {
  id: number
  displayId: number
  focus(): void
  close(): void
  isDestroyed(): boolean
}

export interface FreezeWindowFactory {
  create(display: DisplayLike, frame: FreezeFrame): OverlayWindowHandle
}

export interface FreezeLogger {
  info(message: string): void
  warn(message: string): void
}

export interface FreezeControllerDeps {
  /** 当前全部显示器，含负坐标副屏 */
  listDisplays(): DisplayLike[]
  /** 按给定缩略尺寸抓取每屏位图（物理像素） */
  captureFrames(thumbnailSize: Size): Promise<FreezeFrame[]>
  windows: FreezeWindowFactory
  shortcuts: ShortcutManager
  /** 触发热键；缺省用内置默认 */
  triggerAccelerator?: string
  /** 退出键；缺省用 Escape */
  exitAccelerator?: string
  /** 决定进入冻结时聚焦哪块屏（通常取光标所在屏）；缺省聚焦第一块可用屏 */
  pointOfInterest?: () => Point
  logger?: FreezeLogger
}

export interface FreezeController {
  /** 注册触发热键；返回是否注册成功（被占用时为 false） */
  start(): boolean
  enter(): Promise<void>
  exit(): void
  /** 应用退出前调用：注销全部快捷键并拆掉覆盖层 */
  dispose(): void
  isFrozen(): boolean
  windows(): readonly OverlayWindowHandle[]
}

export function createFreezeController(deps: FreezeControllerDeps): FreezeController {
  const triggerAccelerator = deps.triggerAccelerator ?? DEFAULT_FREEZE_ACCELERATOR
  const exitAccelerator = deps.exitAccelerator ?? FREEZE_EXIT_ACCELERATOR

  let created: OverlayWindowHandle[] = []
  let frozen = false
  let entering: Promise<void> | null = null

  async function doEnter(): Promise<void> {
    const displays = deps.listDisplays()
    if (displays.length === 0) {
      throw new Error('无法进入冻结态：未检测到任何显示器')
    }

    deps.shortcuts.register(exitAccelerator, () => exit())

    const opened: OverlayWindowHandle[] = []
    try {
      const thumbnailSize = captureThumbnailSize(displays)
      const frames = await deps.captureFrames(thumbnailSize)
      const plan = matchSourcesToDisplays(frames, displays)
      if (plan.missingDisplays.length > 0) {
        const ids = plan.missingDisplays.map((display) => display.id).join(', ')
        deps.logger?.warn(`冻结态缺少显示器截屏，已跳过这些屏：${ids}`)
      }
      if (plan.matches.length === 0) {
        throw new Error('无法进入冻结态：未取到任何显示器的截屏')
      }
      for (const { display, source } of plan.matches) {
        opened.push(deps.windows.create(display, source))
      }
      created = opened
      frozen = true
      deps.logger?.info(`已进入冻结态，覆盖 ${opened.length} 块显示器`)
      focusWindowFor(displays, opened)
    } catch (error) {
      for (const window of opened) {
        if (!window.isDestroyed()) {
          window.close()
        }
      }
      deps.shortcuts.unregister(exitAccelerator)
      throw error
    }
  }

  function focusWindowFor(displays: DisplayLike[], opened: OverlayWindowHandle[]): void {
    const point = deps.pointOfInterest?.()
    const target =
      point === undefined ? undefined : displayContainingPoint(displays, point)
    const window =
      target === undefined
        ? opened[0]
        : opened.find((candidate) => candidate.displayId === target.id)
    window?.focus()
  }

  function enter(): Promise<void> {
    if (frozen) {
      return Promise.resolve()
    }
    if (entering !== null) {
      return entering
    }
    entering = doEnter().finally(() => {
      entering = null
    })
    return entering
  }

  function exit(): void {
    if (!frozen) {
      return
    }
    deps.shortcuts.unregister(exitAccelerator)
    for (const window of created) {
      if (!window.isDestroyed()) {
        window.close()
      }
    }
    created = []
    frozen = false
  }

  function start(): boolean {
    return deps.shortcuts.register(triggerAccelerator, () => {
      void enter()
    })
  }

  function dispose(): void {
    exit()
    deps.shortcuts.unregisterAll()
  }

  return {
    start,
    enter,
    exit,
    dispose,
    isFrozen: () => frozen,
    windows: () => created,
  }
}
