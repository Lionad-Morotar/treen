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
import type { Candidate } from '../highlight/candidates'

/**
 * 冻结态编排：进入时截屏、逐屏建覆盖窗；退出时无条件拆掉全部窗口与快捷键。
 *
 * 所有 Electron 能力都经依赖注入（取屏、截屏、建窗、快捷键），控制器本身只在纯逻辑层
 * 运转，因而可在 Node 下被单测覆盖。真实 Electron 绑定在适配层提供。
 *
 * 生命周期不变量：任何失败路径都不得留下置顶透明窗或残留的全局快捷键——否则冻结窗会变成
 * 一块吞掉全屏点击的隐形层，用户无法自行恢复。由此派生两条硬约束：
 * - 退出键注册失败即放弃进入冻结，绝不出现「有遮罩、无出口」的组合；
 * - 进入流程的失败要让用户看得见（经 reportError），不能静默无反应。
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
  /** 注入该屏的候选区域（悬停高亮与后续框选的数据源）；窗口已销毁时实现方须静默忽略。 */
  setCandidates(candidates: readonly Candidate[]): void
}

export interface FreezeWindowFactory {
  create(display: DisplayLike, frame: FreezeFrame): OverlayWindowHandle
}

export interface FreezeLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
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
  /**
   * 按屏计算候选区域；缺省即不注入候选，冻结只铺画面。
   * 结果不阻塞冻结进入——候选是叠在画面上的精修信息，画面与 Escape 出口都不该等它。
   */
  buildCandidates?(display: DisplayLike, frame: FreezeFrame): Promise<readonly Candidate[]>
  /** 把「用户触发但失败」的原因交给壳层呈现（对话框等）；纯 Logic 侧不决定呈现方式 */
  reportError?(message: string): void
  logger?: FreezeLogger
}

export interface FreezeController {
  /** 注册触发热键；返回是否注册成功（被占用时为 false） */
  start(): boolean
  enter(): Promise<void>
  exit(): void
  /** 应用退出前调用：注销全部快捷键并拆掉覆盖层；此后 enter 不再生效 */
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
  let disposed = false

  function exit(): void {
    if (!frozen) {
      return
    }
    deps.shortcuts.unregister(exitAccelerator)
    closeAll(created)
    created = []
    frozen = false
  }

  async function runEnter(): Promise<void> {
    const displays = deps.listDisplays()
    if (displays.length === 0) {
      throw new Error('无法进入冻结态：未检测到任何显示器')
    }

    // 退出键是冻结态唯一的常规出口，注册不上就不进冻结：宁可什么都不做，也不留下无出口的遮罩。
    const exitRegistered = deps.shortcuts.register(exitAccelerator, () => exit())
    if (!exitRegistered) {
      throw new Error(`无法进入冻结态：退出键 ${exitAccelerator} 注册失败`)
    }

    const opened: OverlayWindowHandle[] = []
    try {
      const thumbnailSize = captureThumbnailSize(displays)
      const frames = await deps.captureFrames(thumbnailSize)

      // 截屏在途期间可能已经 dispose（应用退出）或 exit；此时不能再建窗，直接收尾退出键。
      if (disposed) {
        deps.shortcuts.unregister(exitAccelerator)
        return
      }

      const plan = matchSourcesToDisplays(frames, displays)
      if (plan.missingDisplays.length > 0) {
        const ids = plan.missingDisplays.map((display) => display.id).join(', ')
        deps.logger?.warn(`冻结态缺少显示器截屏，已跳过这些屏：${ids}`)
      }
      if (plan.matches.length === 0) {
        throw new Error('无法进入冻结态：未取到任何显示器的截屏')
      }
      for (const { display, source } of plan.matches) {
        const handle = deps.windows.create(display, source)
        opened.push(handle)
        startCandidateBuild(handle, display, source)
      }
      created = opened
      frozen = true
      deps.logger?.info(`已进入冻结态，覆盖 ${opened.length} 块显示器`)
      focusWindowFor(displays, opened)
    } catch (error) {
      closeAll(opened)
      deps.shortcuts.unregister(exitAccelerator)
      throw error
    }
  }

  async function doEnter(): Promise<void> {
    try {
      await runEnter()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.logger?.error(message)
      deps.reportError?.(message)
      throw error
    }
  }

  /**
   * 后台把候选区域算出来并注入对应覆盖窗。
   * 刻意不被 enter 等待：候选区域叠加在已经显示的画面之上，把它串进冻结进入的关键路径
   * 只会推迟用户看到画面；失败也只记日志，不改变冻结仍在可用状态这一事实。
   */
  function startCandidateBuild(
    handle: OverlayWindowHandle,
    display: DisplayLike,
    frame: FreezeFrame,
  ): void {
    const build = deps.buildCandidates
    if (build === undefined) {
      return
    }
    void build(display, frame)
      .then((candidates) => {
        handle.setCandidates(candidates)
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        deps.logger?.warn(`显示器 ${display.id} 的候选区域计算失败：${message}`)
      })
  }

  function closeAll(windows: OverlayWindowHandle[]): void {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.close()
      }
    }
  }

  function focusWindowFor(displays: DisplayLike[], opened: OverlayWindowHandle[]): void {
    const point = deps.pointOfInterest?.()
    const target = point === undefined ? undefined : displayContainingPoint(displays, point)
    const window =
      target === undefined
        ? opened[0]
        : opened.find((candidate) => candidate.displayId === target.id)
    window?.focus()
  }

  function enter(): Promise<void> {
    if (disposed || frozen) {
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

  function start(): boolean {
    return deps.shortcuts.register(triggerAccelerator, () => {
      // 失败已在 doEnter 内经 reportError 呈现，这里吞掉 rejection 只为避免未处理拒绝告警。
      void enter().catch(() => {})
    })
  }

  function dispose(): void {
    disposed = true
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
