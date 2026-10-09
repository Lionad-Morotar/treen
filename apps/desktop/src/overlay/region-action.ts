import type { TreenSettings } from '@treen/shared'
import type { FreezeLogger, RegionLockTarget, RegionTranslateAction } from '../freeze/controller'
import type { LatestGate } from '../freeze/latest-gate'
import type { Rect } from '../freeze/geometry'
import type { TranslateOutcome, TranslatedBlock } from '../translation/link'
import type { OverlayPlan } from './layout'

/**
 * 「锁定一块区域就翻译并覆盖回屏幕」的动作装配（纯逻辑）。
 *
 * 链路：读当前设置 → 门控 → OCR +（可选）翻译 → 覆盖计划 → 注入该屏覆盖窗。
 * 两个开关的语义在这里落地：
 * - `translateText` 关：翻译步骤被跳过（省一次外部调用），OCR 照跑——图仍需源码；
 *   覆盖计划也不再产出译文层，避免空译文盒盖上去。
 * - `translateCharts` 关：覆盖计划不注入渲染方，整段 mermaid 检测与渲染都不发生。
 * 两者正交，全关则一次触发什么都不做（连 OCR 都不发起）。
 *
 * 设置**每次触发时重新读**：开关与热键都要求改完即生效，缓存会引入一层失效时机的隐式约定。
 * 控制器不感知设置——它只管在锁定跳变时调这个动作，门控全部收在这里，控制器因此保持纯逻辑。
 *
 * 覆盖是整批替换，而这条链（OCR + 外部翻译 + 渲染站）耗时不短：连着点两块区域会让两条链并发，
 * 先发起的可能后完成。代次闸门按发起次序发号，过期结果不注入。
 *
 * loading 与链路同生命周期：确认要发起链路后立刻在锁定区域显示扫描线，链路离开的每一个
 * 出口（落地、被更新点击取代、翻译被跳过、失败、冻结退出经 invalidate）都收掉它——
 * 收口统一放在 finally，漏一个出口就是一条永远在扫的线。
 */

/** 覆盖窗的控制面。控制器句柄是该接口的超集，装配层可直接传 `freeze.windows()`。 */
export interface OverlaySink {
  displayId: number
  isDestroyed(): boolean
  setOverlay(plan: OverlayPlan): void
  /** 在该屏锁定区域显示翻译 loading（显示器相对 DIP）；已显示时刷新位置。 */
  setLoading(region: Rect): void
  /**
   * 收掉该屏「给定区域」的翻译 loading；当前显示的不是这个区域时不动作。
   * loading 层每屏一份、由最新一次点击拥有：旧链终态只能退役自己那块区域的线，
   * 否则同屏连点两块时，先完成的旧链会把新链正在扫的线收掉。
   */
  clearLoading(region: Rect): void
}

/** 覆盖计划的两个开关，与设置字段同义，收窄成显式的两项以免动作层依赖完整设置形状。 */
export interface OverlayPlanOptions {
  texts: boolean
  charts: boolean
}

export interface RegionLockActionDeps {
  /** 读当前用户设置；每次触发读一次 */
  readSettings(): TreenSettings
  /** 翻译锁定选区；`translateText` 为 false 时实现方应跳过外部翻译调用 */
  translate(
    displayId: number,
    options: { translateText: boolean },
  ): Promise<TranslateOutcome>
  /** 依开关装配覆盖计划 */
  compose(
    blocks: readonly TranslatedBlock[],
    region: Rect,
    options: OverlayPlanOptions,
  ): Promise<OverlayPlan>
  /** 当前各屏的覆盖窗 */
  overlays(): readonly OverlaySink[]
  gate: LatestGate
  logger?: FreezeLogger
}

export function createRegionLockAction(
  deps: RegionLockActionDeps,
): RegionTranslateAction {
  async function run(target: RegionLockTarget, token: number): Promise<void> {
    const settings = deps.readSettings()
    if (!settings.translateText && !settings.translateCharts) {
      deps.logger?.info(`显示器 ${target.displayId}：翻译文本与图表均已关闭，不触发任何链路`)
      return
    }

    // loading 显示在目标屏的覆盖窗上：窗口不在（该屏无窗或已销毁）时链路照旧跑，
    // 跳过与否由落地前的既有检查点裁决，这里只决定 loading 有没有落点。
    const sink = deps.overlays().find((candidate) => candidate.displayId === target.displayId)
    if (sink !== undefined && !sink.isDestroyed()) {
      sink.setLoading(target.region)
    }
    try {
      const outcome = await deps.translate(target.displayId, {
        translateText: settings.translateText,
      })
      if (!deps.gate.isCurrent(token)) {
        deps.logger?.info(`显示器 ${target.displayId} 的结果已被更晚的一次点击取代，丢弃`)
        return
      }
      if (outcome.kind !== 'translated') {
        deps.logger?.info(`点击翻译跳过（${outcome.reason}）：显示器 ${target.displayId}`)
        return
      }

      const plan = await deps.compose(outcome.blocks, outcome.region, {
        texts: settings.translateText,
        charts: settings.translateCharts,
      })
      if (!deps.gate.isCurrent(token)) {
        deps.logger?.info(`显示器 ${outcome.displayId} 的覆盖计划已过期，不注入`)
        return
      }

      if (sink === undefined || sink.isDestroyed()) {
        deps.logger?.warn(`显示器 ${outcome.displayId} 的覆盖窗已不在，放弃覆盖`)
        return
      }
      sink.setOverlay(plan)
      deps.logger?.info(
        `覆盖已注入：显示器 ${outcome.displayId}，${plan.texts.length} 段译文、${plan.charts.length} 张图`,
      )
    } finally {
      // loading 的全部消失时机都收敛在这一个出口：任何离开链路的方式（含抛错与被作废）
      // 都要退役自己的扫描线。收的是 target.region 而非「当前层上 whatever」——同屏连点时
      // 先完成的旧链若无条件收线，会把新链正在扫的线收掉；窗口已销毁时不必再调，
      // DOM 随窗口一起没了。
      if (sink !== undefined && !sink.isDestroyed()) {
        sink.clearLoading(target.region)
      }
    }
  }

  return {
    trigger: (target) => {
      const token = deps.gate.begin()
      void run(target, token).catch((error: unknown) => {
        deps.logger?.warn(`覆盖渲染失败：${error instanceof Error ? error.message : String(error)}`)
      })
    },
    invalidate: () => deps.gate.invalidate(),
  }
}
