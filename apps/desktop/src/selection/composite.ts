import { createLatestGate } from '../freeze/latest-gate'
import type { FreezeAction, FreezeLogger, SelectionSource } from '../freeze/controller'
import type { Point, Rect } from '../freeze/geometry'
import { pickCopyTarget } from './selection'

/**
 * 合成图像拷贝的纯逻辑：挑出这次该拷哪一屏的哪一块，交给注入的抓取方去取像素，再写进剪贴板。
 *
 * 与「拷贝原始截图」的区别只在取数源：那条路裁的是截屏帧位图，天然不含覆盖内容；这条抓的是
 * 覆盖窗当前的渲染结果，译文与图都在里面。挑选规则（锁定优先、多屏取光标所在屏）两者共用，
 * 免得同一套意图推断出现两份会漂移的实现。
 *
 * 裁剪矩形留 DIP：渲染结果按 DIP 抓，不做帧位图那套颜色/尺度换算。
 */

export type CompositeOutcome =
  | { kind: 'copied'; displayId: number; fromLock: boolean; region: Rect }
  | {
      kind: 'skipped'
      reason: 'no-window' | 'no-target' | 'no-capture' | 'superseded'
    }

export interface CompositeCopierDeps {
  /** 收集各屏当前的选区素材（锁定选区由各覆盖窗的渲染层拉取而来） */
  readSources(): Promise<readonly SelectionSource[]>
  /** 抓取某屏覆盖窗渲染结果中的这块区域（显示器相对 DIP）；取不到像素时为 null */
  capture(source: SelectionSource, region: Rect): Promise<Uint8Array | null>
  /** 把 PNG 字节写进剪贴板 */
  writePng(png: Uint8Array): Promise<void>
  pointer?(): Point
  logger?: FreezeLogger
}

/**
 * 冻结期的「拷贝合成图」动作用它。返回 FreezeAction：trigger 发起一轮，invalidate
 * 作废在途轮（冻结退出时由控制器调用）。
 *
 * await 点比原始截图拷贝多（读素材、抓取、写盘三个），每两个之间都要核对一次号码，
 * 只核对一次挡不住插进来的那一轮。抓取落空（null）先于 no-capture 判代次：该轮已被
 * 更晚一轮取代时，读到的素材本身已作废，报 superseded 而不是 no-capture——两者对
 * 调用方含义不同，前者是「有更新的轮次在跑」，后者是「这一屏真的没有渲染结果」。
 */
export function createCompositeCopier(deps: CompositeCopierDeps): FreezeAction {
  const gate = createLatestGate()

  async function run(token: number): Promise<CompositeOutcome> {
    const sources = await deps.readSources()
    if (!gate.isCurrent(token)) {
      deps.logger?.info('合成拷贝跳过：已被更晚的一次合成拷贝取代')
      return { kind: 'skipped', reason: 'superseded' }
    }
    const target = pickCopyTarget(sources, deps.pointer?.())
    if (target === null) {
      deps.logger?.warn('合成拷贝跳过：冻结态没有可用的覆盖窗')
      return { kind: 'skipped', reason: 'no-window' }
    }

    const { source, region, fromLock } = target
    if (region.width <= 0 || region.height <= 0) {
      deps.logger?.warn(`合成拷贝跳过：显示器 ${source.display.id} 的选区是空区域`)
      return { kind: 'skipped', reason: 'no-target' }
    }

    const png = await deps.capture(source, region)
    if (!gate.isCurrent(token)) {
      deps.logger?.info('合成拷贝跳过：已被更晚的一次合成拷贝取代')
      return { kind: 'skipped', reason: 'superseded' }
    }
    if (png === null) {
      // 抓不到像素说明这一屏当时没有可用的渲染结果；写一张空图进剪贴板比什么都不写更糟。
      deps.logger?.warn(`合成拷贝跳过：显示器 ${source.display.id} 抓不到渲染结果`)
      return { kind: 'skipped', reason: 'no-capture' }
    }

    await deps.writePng(png)
    if (!gate.isCurrent(token)) {
      // 写已发生且无法撤回；如实报告过期（同原始截图拷贝的写序竞态残余）。
      deps.logger?.info('合成拷贝完成但已被更晚的一次取代，视为未拷贝')
      return { kind: 'skipped', reason: 'superseded' }
    }
    deps.logger?.info(
      `已拷贝${fromLock ? '锁定选区的' : '整屏的'}合成画面：显示器 ${source.display.id} ` +
        `${region.width}×${region.height}（DIP）`,
    )
    return { kind: 'copied', displayId: source.display.id, fromLock, region }
  }

  return {
    trigger(): Promise<CompositeOutcome> {
      return run(gate.begin())
    },
    invalidate(): void {
      gate.invalidate()
    },
  }
}
