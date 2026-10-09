import {
  captureThumbnailSize,
  displayContainingPoint,
  matchSourcesToDisplays,
  type CaptureSourceLike,
  type DisplayLike,
  type Point,
  type Rect,
  type Size,
} from './geometry'
import {
  DEFAULT_FREEZE_ACCELERATOR,
  FREEZE_COPY_ACCELERATOR,
  FREEZE_EXIT_ACCELERATOR,
} from './window-options'
import type { ShortcutManager } from './shortcuts'
import type { Candidate } from '../highlight/candidates'
import type { OverlayPlan } from '../overlay/layout'

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

/**
 * 一屏的选区拷贝素材：原始截屏帧、其显示器几何、渲染层当前锁定的选区。
 *
 * 选区真源在渲染层（点击发生在那里），主进程按需向覆盖窗拉取而不是维持一份镜像：
 * 覆盖窗是 contextIsolation + sandbox 的页面，镜像一份就要造反向 IPC 通道。
 */
export interface SelectionSource {
  display: DisplayLike
  frame: FreezeFrame
  /** 显示器相对 DIP；未锁定时为 null，调用方按整屏处理 */
  locked: Rect | null
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
  /** 读取该屏的选区素材；窗口已失效时返回 null，由调用方跳过这一屏。 */
  readSelection(): Promise<SelectionSource | null>
  /** 只读该屏当前锁定的选区；未锁定或窗口失效均为 null。轮询用它，比 readSelection 轻。 */
  readLocked(): Promise<Rect | null>
  /** 注入覆盖计划（译文与图表的落点）；窗口已销毁时实现方须静默忽略。 */
  setOverlay(plan: OverlayPlan): void
}

/**
 * 锁定跳变的触发目标：某屏出现新的锁定时，把该屏与锁定矩形交给动作方。
 *
 * 触发方式是纯拉取式轮询——渲染层（点击发生地）没有 Node 能力也不反向通知主进程，
 * 主进程按固定间隔读各覆盖窗的锁定，检测到「出现了此前没有的锁定」即触发翻译。
 */
export interface RegionLockTarget {
  displayId: number
  region: Rect
}

/** 轮询用的定时器抽象：注入是为了让控制器在测试里用确定性调度，不依赖真实时钟。 */
export interface LockPollTimers {
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** 锁定轮询的默认间隔（毫秒）。只影响点击到译文的感知延迟，不改变接口形状。 */
export const DEFAULT_LOCK_POLL_INTERVAL_MS = 60

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
  /** 拷贝键；缺省用内置默认 */
  copyAccelerator?: string
  /**
   * 冻结期把原始截图拷进剪贴板。缺省即不注册拷贝键，冻结只剩画面与出口。
   *
   * 返回值不被等待（全局快捷键没有等待方），同步抛错与 Promise 拒绝都会收进日志：
   * 拷贝失败不该把冻结态整个拆掉，但也不能静默无反应。
   */
  copySelection?: () => unknown
  /**
   * 冻结期轮询到某屏出现新锁定时触发翻译。缺省即不轮询——冻结只铺画面与出口。
   *
   * 触发源是拉取式轮询而非全局快捷键：需求要的是「鼠标点击即触发」，而点击发生在渲染层，
   * 主进程没有点击时刻的协调点。轮询以「锁定从无到有 / 换了一块」为跳变判据，反复读到同一块
   * 不重复触发。返回值不被等待，同步抛错与 Promise 拒绝都收进日志，不拆掉冻结态。
   */
  onRegionLocked?: (target: RegionLockTarget) => unknown
  /** 轮询间隔（毫秒）；缺省 DEFAULT_LOCK_POLL_INTERVAL_MS */
  lockPollIntervalMs?: number
  /** 定时器注入点；缺省用全局 setInterval / clearInterval，测试注入确定性调度 */
  timers?: LockPollTimers
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
  const copyAccelerator = deps.copyAccelerator ?? FREEZE_COPY_ACCELERATOR
  const lockPollIntervalMs = deps.lockPollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS
  const timers: LockPollTimers = deps.timers ?? {
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  }

  let created: OverlayWindowHandle[] = []
  let frozen = false
  let entering: Promise<void> | null = null
  let disposed = false
  /** 锁定轮询的定时器句柄；null 表示未在轮询。 */
  let lockPollHandle: unknown = null
  /** 上一轮读到的各屏锁定；键是 displayId。用于检测「出现了新锁定」。 */
  const lastLocks = new Map<number, Rect | null>()
  /** 一次轮询尚未读完时不再叠加下一次：读动作是异步的，慢于间隔就会堆积。 */
  let polling = false
  /** 读锁定失败的屏；失败连续发生时只警告一次，读到成功即清。 */
  const failingReads = new Set<number>()

  /** 冻结期的快捷键只在冻结期存活：进入时注册、任何退出路径上释放。 */
  function releaseShortcuts(): void {
    deps.shortcuts.unregister(exitAccelerator)
    deps.shortcuts.unregister(copyAccelerator)
  }

  /**
   * 注册一个冻结期的辅助动作键（拷贝、翻译）。
   * 与退出键不同，注册不上只记日志：退出键是冻结态唯一的常规出口，缺失即形成无出口的置顶透明层；
   * 辅助动作只是便利功能，代价面不对称。
   */
  function registerActionShortcut(
    accelerator: string,
    action: (() => unknown) | undefined,
    label: string,
  ): void {
    if (action === undefined) {
      return
    }
    const registered = deps.shortcuts.register(accelerator, () => {
      // handler 不能是 async：全局快捷键不消费返回值，异常只会变成未处理拒绝。
      void Promise.resolve()
        .then(() => action())
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          deps.logger?.warn(`${label}失败：${message}`)
        })
    })
    if (!registered) {
      deps.logger?.warn(`${label}的快捷键 ${accelerator} 注册失败，冻结期不可用`)
    }
  }

  function sameRect(a: Rect | null, b: Rect | null): boolean {
    if (a === null || b === null) {
      return a === b
    }
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  }

  /** 交给触发动作，失败只记日志：一次翻译失败不该把整块冻结态拆掉。 */
  function fireRegionLocked(displayId: number, region: Rect): void {
    const action = deps.onRegionLocked
    if (action === undefined) {
      return
    }
    void Promise.resolve()
      .then(() => action({ displayId, region }))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        deps.logger?.warn(`显示器 ${displayId} 的翻译触发失败：${message}`)
      })
  }

  /**
   * 读一轮各覆盖窗的锁定并检测跳变。
   *
   * 「跳变」定义为某屏出现了与上一轮不同的非空锁定——首次锁定（null → 矩形）与换锁
   * （矩形 A → 矩形 B）都算，反复读到同一块不算。换锁也触发是有意的：用户点了另一块区域
   * 期望的就是译那一块的译文，只认 null → 矩形会让第二次选择静默失效。
   *
   * 读失败**不当作未锁定**：覆盖窗的注入原语偶发失败时（页面繁忙、注入尚未就绪），把它记成
   * null 会让下一轮读到同一块锁时满足 null → 矩形的跳变判据，同一块区域被重复 OCR 与翻译
   * （外部模型按次计费），且整批覆盖被再注入一次。读不到就保留上一轮的已知状态，本轮不触发。
   */
  async function pollOnce(): Promise<void> {
    if (!frozen || polling) {
      return
    }
    polling = true
    try {
      const handles = created
      const snapshot = await Promise.all(
        handles.map(async (handle) => {
          try {
            const locked = await handle.readLocked()
            failingReads.delete(handle.displayId)
            return { handle, locked }
          } catch (error) {
            if (!failingReads.has(handle.displayId)) {
              failingReads.add(handle.displayId)
              const message = error instanceof Error ? error.message : String(error)
              deps.logger?.warn(`读显示器 ${handle.displayId} 的锁定区域失败：${message}`)
            }
            return { handle, locked: undefined }
          }
        }),
      )
      // 读取在途期间可能已退出冻结：窗口已拆，不再做任何触发。
      if (!frozen) {
        return
      }
      for (const { handle, locked } of snapshot) {
        if (locked === undefined) {
          continue
        }
        const previous = lastLocks.get(handle.displayId) ?? null
        lastLocks.set(handle.displayId, locked)
        if (locked !== null && !sameRect(previous, locked)) {
          fireRegionLocked(handle.displayId, locked)
        }
      }
    } finally {
      polling = false
    }
  }

  /** 冻结态才轮询；缺省动作即不轮询。进入与退出是本函数的唯一开关点。 */
  function startLockWatch(): void {
    if (deps.onRegionLocked === undefined || lockPollHandle !== null) {
      return
    }
    lastLocks.clear()
    failingReads.clear()
    lockPollHandle = timers.setInterval(() => {
      void pollOnce()
    }, lockPollIntervalMs)
  }

  function stopLockWatch(): void {
    if (lockPollHandle !== null) {
      timers.clearInterval(lockPollHandle)
      lockPollHandle = null
    }
    lastLocks.clear()
    failingReads.clear()
  }

  function exit(): void {
    if (!frozen) {
      return
    }
    stopLockWatch()
    releaseShortcuts()
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
    registerActionShortcut(copyAccelerator, deps.copySelection, '拷贝冻结画面')

    const opened: OverlayWindowHandle[] = []
    try {
      const thumbnailSize = captureThumbnailSize(displays)
      const frames = await deps.captureFrames(thumbnailSize)

      // 截屏在途期间可能已经 dispose（应用退出）或 exit；此时不能再建窗，直接收尾快捷键。
      if (disposed) {
        releaseShortcuts()
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
      startLockWatch()
      deps.logger?.info(`已进入冻结态，覆盖 ${opened.length} 块显示器`)
      focusWindowFor(displays, opened)
    } catch (error) {
      closeAll(opened)
      releaseShortcuts()
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
    // 先落进微任务再加链：返回值是 Promise 只是类型约定，不约束实现一定是 async 函数，
    // 一个同步抛错的实现会让异常直接穿出 runEnter 的 catch，把整个冻结拆掉。
    void Promise.resolve()
      .then(() => build(display, frame))
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
      // 热键在冻结态里是开关：用户按第二下想要的是「取消」，而不是按了没反应。
      // 只在真的已经冻结时走退出；进入在途时（截屏未回）第二下仍是幂等的重入，
      // 打断它需要给进入流程加中止语义，那是另一件事。
      if (frozen) {
        exit()
        return
      }
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
