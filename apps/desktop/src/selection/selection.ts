import {
  dipRectToFrameRect,
  displayContainingPoint,
  type DisplayLike,
  type Point,
  type Rect,
} from '../freeze/geometry'
import type { FreezeFrame, FreezeLogger, SelectionSource } from '../freeze/controller'

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
  | { kind: 'skipped'; reason: 'no-window' | 'frame-size-unknown' | 'no-target' }

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
      pointer === undefined ? undefined : locked.find((source) => containsPoint(source.display, pointer))
    const chosen = pointed ?? locked[0]
    if (chosen !== undefined) {
      return { source: chosen, region: chosen.locked, fromLock: true }
    }
  }
  const only = sources[0]
  if (only === undefined) {
    return null
  }
  return { source: only, region: wholeDisplayRect(only.display), fromLock: false }
}

function containsPoint(display: DisplayLike, point: Point): boolean {
  return displayContainingPoint([display], point) !== undefined
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
export function createSelectionCopier(deps: SelectionCopierDeps): () => Promise<CopyOutcome> {
  return async () => {
    const sources = await deps.readSources()
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
    deps.logger?.info(
      `已拷贝${fromLock ? '锁定选区' : '整屏'}：显示器 ${source.display.id} ` +
        `像素 ${pixelRect.width}×${pixelRect.height}`,
    )
    return { kind: 'copied', displayId: source.display.id, fromLock, pixelRect }
  }
}
