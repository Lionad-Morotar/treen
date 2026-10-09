import {
  dipRectToFrameRect,
  displayContainingPoint,
  type DisplayLike,
  type Point,
  type Rect,
} from '../freeze/geometry'
import { createLatestGate } from '../freeze/latest-gate'
import type {
  FreezeAction,
  FreezeFrame,
  FreezeLogger,
  SelectionSource,
} from '../freeze/controller'

/**
 * 选区拷贝的纯逻辑：挑出这次该拷哪一屏的哪一块，把显示器相对 DIP 换算成帧位图像素，
 * 再把裁剪交给注入的写盘方。
 *
 * 解码、裁剪、写剪贴板都是 Electron 运行时能力，留到适配层；这里只在坐标与决策上运转，
 * 因而可在纯 Node 下被单测覆盖。真链路由冻结冒烟兜住。
 */

/** 这次拷贝的目标：一屏的素材，以及要裁的区域（显示器相对 DIP）。 */
export interface CopyTarget {
  source: SelectionSource
  region: Rect
  /** 区域来自锁定选区（true）还是整屏回退（false） */
  fromLock: boolean
}

export type CopyOutcome =
  | { kind: 'copied'; displayId: number; fromLock: boolean; pixelRect: Rect }
  | {
      kind: 'skipped'
      reason: 'no-window' | 'frame-size-unknown' | 'no-target' | 'superseded'
    }

/** 一屏整幅的显示器相对 DIP 矩形。 */
export function wholeDisplayRect(display: DisplayLike): Rect {
  return { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }
}

/**
 * 选出这次拷贝的目标。
 *
 * 锁定选区优先于整屏回退：验收以「冻结期间」限定拷贝的时机，没有要先锁定的前置，
 * 但锁定之后用户要拷的显然是锁定的那一块。
 *
 * 多屏同时有锁定时取光标所在屏。拉取式架构下主进程没有点击时刻的协调点（点击只发生在
 * 覆盖窗的渲染层里），光标是唯一现成的意图信号；光标不在任何含锁的屏上则按素材次序取第一个，
 * 不因为光标在别处就把锁定丢掉。
 */
export function pickCopyTarget(
  sources: readonly SelectionSource[],
  pointer?: Point,
): CopyTarget | null {
  const locked = sources.filter(
    (source): source is SelectionSource & { locked: Rect } => source.locked !== null,
  )
  if (locked.length > 0) {
    const pointed =
      pointer === undefined
        ? undefined
        : locked.find((source) => containsPoint(source.display, pointer))
    const chosen = pointed ?? locked[0]
    if (chosen !== undefined) {
      return { source: chosen, region: chosen.locked, fromLock: true }
    }
  }
  // 无锁回退同样以光标定屏：用户此时看着哪块屏，要拷的就是那块。光标落在任何一屏之外
  // （极少见，窗口间的一道缝、或光标已被移出桌面）才按素材次序取第一块。
  const pointedFree =
    pointer === undefined
      ? undefined
      : sources.find((source) => containsPoint(source.display, pointer))
  const fallback = pointedFree ?? sources[0]
  if (fallback === undefined) {
    return null
  }
  return { source: fallback, region: wholeDisplayRect(fallback.display), fromLock: false }
}

function containsPoint(display: DisplayLike, point: Point): boolean {
  return displayContainingPoint([display], point) !== undefined
}

/**
 * 按屏选目标：已知是哪块屏的锁定时用它，不再靠光标推断。
 *
 * 锁定触发（轮询）走这条：触发源已给出 displayId，多屏各有锁定时不能退化成「光标在哪就译哪」。
 * 该屏不存在或没有锁定即返回 null（触发源只会报有锁定的屏，这里是防御）。
 */
export function pickTargetForDisplay(
  sources: readonly SelectionSource[],
  displayId: number,
): CopyTarget | null {
  const source = sources.find((candidate) => candidate.display.id === displayId)
  if (source === undefined || source.locked === null) {
    return null
  }
  return { source, region: source.locked, fromLock: true }
}

export interface SelectionCopierDeps {
  /** 收集各屏当前的选区素材（锁定选区由各覆盖窗的渲染层拉取而来） */
  readSources(): Promise<readonly SelectionSource[]>
  /** 把帧的某块像素写进剪贴板；rect 是帧位图像素坐标 */
  writeCrop(frame: FreezeFrame, rect: Rect): Promise<void>
  pointer?(): Point
  logger?: FreezeLogger
}

/**
 * 冻结期的「拷贝原始截图」动作用它。返回结果只为让调用方与测试能断言发生了什么，
 * 失败不在这里吞掉：交给调用方决定呈现方式（控制器把它收进日志）。
 */
/**
 * 冻结期的「拷贝原始截图」动作用它。返回 FreezeAction：trigger 发起一轮，invalidate
 * 作废在途轮（冻结退出时由控制器调用）。
 *
 * 连按两次时两条链路并发，先发起的可能后落地——闸门按发起次序发号，素材读完与写盘
 * 完成后各核对一次号码，过期即丢弃。写盘后再核对是因为 writeCrop 的 await 期间第二轮
 * 可能已经开始甚至完成，只核对一次挡不住插进来的那一轮。结果只为让调用方与测试能断言
 * 发生了什么，失败不在这里吞掉：交给调用方决定呈现方式（控制器把它收进日志）。
 */
export function createSelectionCopier(deps: SelectionCopierDeps): FreezeAction {
  const gate = createLatestGate()

  async function run(token: number): Promise<CopyOutcome> {
    const sources = await deps.readSources()
    if (!gate.isCurrent(token)) {
      deps.logger?.info('拷贝跳过：已被更晚的一次拷贝取代')
      return { kind: 'skipped', reason: 'superseded' }
    }
    const target = pickCopyTarget(sources, deps.pointer?.())
    if (target === null) {
      deps.logger?.warn('拷贝跳过：冻结态没有可用的覆盖窗')
      return { kind: 'skipped', reason: 'no-window' }
    }

    const { source, region, fromLock } = target
    if (sources.filter((candidate) => candidate.locked !== null).length > 1) {
      deps.logger?.warn(`多块显示器各有锁定选区，本次拷贝取显示器 ${source.display.id}`)
    }

    const frameSize = source.frame.size
    if (frameSize === null) {
      // 没有位图尺寸就无从换算裁剪矩形，宁可什么都不写也不猜一个比例。
      deps.logger?.warn(`拷贝跳过：显示器 ${source.display.id} 的截屏帧尺寸未知`)
      return { kind: 'skipped', reason: 'frame-size-unknown' }
    }
    const pixelRect = dipRectToFrameRect(region, source.display, frameSize)
    if (pixelRect === null) {
      deps.logger?.warn(`拷贝跳过：显示器 ${source.display.id} 的选区换算不出有效像素区域`)
      return { kind: 'skipped', reason: 'no-target' }
    }

    await deps.writeCrop(source.frame, pixelRect)
    if (!gate.isCurrent(token)) {
      // 写已发生且无法撤回；如实报告过期，别让调用方把这一轮当成有效拷贝。
      // 残余竞态：两轮写的完成序颠倒时剪贴板最终是旧素材，彻底解需适配层串行化，
      // 纯逻辑层只能保证不谎报结果。
      deps.logger?.info('拷贝完成但已被更晚的一次拷贝取代，视为未拷贝')
      return { kind: 'skipped', reason: 'superseded' }
    }
    deps.logger?.info(
      `已拷贝${fromLock ? '锁定选区' : '整屏'}：显示器 ${source.display.id} ` +
        `像素 ${pixelRect.width}×${pixelRect.height}`,
    )
    return { kind: 'copied', displayId: source.display.id, fromLock, pixelRect }
  }

  return {
    trigger(): Promise<CopyOutcome> {
      return run(gate.begin())
    },
    invalidate(): void {
      gate.invalidate()
    },
  }
}
