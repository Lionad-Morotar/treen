import type { FreezeLogger, SelectionSource } from '../freeze/controller'
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
  | { kind: 'skipped'; reason: 'no-window' | 'no-target' | 'no-capture' }

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
 * 冻结期的「拷贝合成图」动作用它。结果只为让调用方与测试能断言发生了什么，
 * 失败不在这里吞掉：交给调用方决定呈现方式（控制器把它收进日志）。
 */
export function createCompositeCopier(
  deps: CompositeCopierDeps,
): () => Promise<CompositeOutcome> {
  return async () => {
    const sources = await deps.readSources()
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
    if (png === null) {
      // 抓不到像素说明这一屏当时没有可用的渲染结果；写一张空图进剪贴板比什么都不写更糟。
      deps.logger?.warn(`合成拷贝跳过：显示器 ${source.display.id} 抓不到渲染结果`)
      return { kind: 'skipped', reason: 'no-capture' }
    }

    await deps.writePng(png)
    deps.logger?.info(
      `已拷贝${fromLock ? '锁定选区的' : '整屏的'}合成画面：显示器 ${source.display.id} ` +
        `${region.width}×${region.height}（DIP）`,
    )
    return { kind: 'copied', displayId: source.display.id, fromLock, region }
  }
}
