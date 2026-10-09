import { describe, expect, it, vi } from 'vitest'
import { createLatestGate } from '../src/freeze/latest-gate'
import {
  createRegionLockAction,
  type OverlayPlanOptions,
  type OverlaySink,
} from '../src/overlay/region-action'
import type { OverlayPlan } from '../src/overlay/layout'
import type { TranslateOutcome, TranslatedBlock } from '../src/translation/link'
import type { Rect } from '../src/freeze/geometry'
import type { TreenSettings } from '@treen/shared'

/**
 * 「锁定即翻译并覆盖」动作的门控测试：两个开关如何改写链路的实际动作。
 * 链路本身的正确性在 translate-link / overlay-compose 各自覆盖，这里只钉开关与覆盖窗的分支。
 */

const REGION: Rect = { x: 0, y: 0, width: 200, height: 100 }

/** 开关全开的一份完整设置；本文件只关心开关，热键取一个占位值。 */
const SETTINGS: TreenSettings = {
  freezeAccelerator: 'Alt+T',
  translateText: true,
  translateCharts: true,
  translateNodeLabels: true,
}

function withSettings(patch: Partial<TreenSettings>): TreenSettings {
  return { ...SETTINGS, ...patch }
}

const BLOCKS: TranslatedBlock[] = [
  { source: '原文', translation: '译文', box: { x: 0, y: 0, width: 80, height: 20 } },
]

function plan(texts: number, charts: number): OverlayPlan {
  return {
    fontFamily: 'monospace',
    lineHeightRatio: 1.25,
    texts: Array.from({ length: texts }, (_, index) => ({
      x: index,
      y: 0,
      width: 80,
      height: 20,
      fontSize: 10,
      lineHeight: 12.5,
      lines: ['行'],
      clipped: false,
    })),
    charts: Array.from({ length: charts }, (_, index) => ({
      x: index,
      y: 0,
      width: 40,
      height: 20,
      svg: '<svg/>',
    })),
  }
}

function sink(displayId = 7, destroyed = false) {
  const setOverlay = vi.fn()
  const setLoading = vi.fn()
  const clearLoading = vi.fn()
  const handle: OverlaySink = {
    displayId,
    isDestroyed: () => destroyed,
    setOverlay,
    setLoading,
    clearLoading,
  }
  return { handle, setOverlay, setLoading, clearLoading }
}

interface HarnessOverrides {
  settings?: TreenSettings
  translate?: (displayId: number, options: { translateText: boolean }) => Promise<TranslateOutcome>
  compose?: (
    blocks: readonly TranslatedBlock[],
    region: Rect,
    options: OverlayPlanOptions,
  ) => Promise<OverlayPlan>
  overlays?: readonly OverlaySink[]
}

function harness(overrides: HarnessOverrides = {}) {
  const translate = vi.fn(
    overrides.translate ??
      (async (): Promise<TranslateOutcome> => ({
        kind: 'translated',
        displayId: 7,
        region: REGION,
        blocks: BLOCKS,
      })),
  )
  const compose = vi.fn(overrides.compose ?? (async () => plan(1, 1)))
  const warn = vi.fn()
  const info = vi.fn()
  const target = sink()
  const gate = createLatestGate()
  const action = createRegionLockAction({
    readSettings: () => overrides.settings ?? withSettings({}),
    translate,
    compose,
    overlays: () => overrides.overlays ?? [target.handle],
    gate,
    logger: { info, warn, error: vi.fn() },
  })
  return {
    action,
    gate,
    translate,
    compose,
    setOverlay: target.setOverlay,
    setLoading: target.setLoading,
    clearLoading: target.clearLoading,
    warn,
    info,
  }
}

/** 等到 action 内部的异步链路跑完（fire-and-forget，测试需显式等待）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('createRegionLockAction：开关的门控', () => {
  it('全部都开：翻译、图表与图内文案都走，计划原样注入', async () => {
    const { action, translate, compose, setOverlay } = harness()

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(translate).toHaveBeenCalledWith(7, { translateText: true })
    expect(compose).toHaveBeenCalledWith(BLOCKS, REGION, { texts: true, charts: true, nodeLabels: true })
    expect(setOverlay).toHaveBeenCalledTimes(1)
  })

  it('关文本开图表：仍识别（OCR 在图链路里要用），但翻译调用被标记跳过，计划只要图', async () => {
    const { action, translate, compose, setOverlay } = harness({
      settings: withSettings({ translateText: false }),
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(translate).toHaveBeenCalledWith(7, { translateText: false })
    expect(compose).toHaveBeenCalledWith(BLOCKS, REGION, { texts: false, charts: true, nodeLabels: true })
    expect(setOverlay).toHaveBeenCalledTimes(1)
  })

  it('开文本关图表：要译文不要图', async () => {
    const { action, translate, compose } = harness({
      settings: withSettings({ translateCharts: false }),
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(translate).toHaveBeenCalledWith(7, { translateText: true })
    expect(compose).toHaveBeenCalledWith(BLOCKS, REGION, { texts: true, charts: false, nodeLabels: true })
  })

  it('关图内文案：图链路照走，但覆盖计划不翻译节点文案', async () => {
    const { action, compose, setOverlay } = harness({
      settings: withSettings({ translateNodeLabels: false }),
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(compose).toHaveBeenCalledWith(BLOCKS, REGION, { texts: true, charts: true, nodeLabels: false })
    expect(setOverlay).toHaveBeenCalledTimes(1)
  })

  it('全部都关：一次触发什么都不做，连翻译都不发起', async () => {
    const { action, translate, compose, setOverlay, info } = harness({
      settings: withSettings({ translateText: false, translateCharts: false, translateNodeLabels: false }),
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(translate).not.toHaveBeenCalled()
    expect(compose).not.toHaveBeenCalled()
    expect(setOverlay).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('均已关闭'))
  })
})

describe('createRegionLockAction：过代次与失败分支', () => {
  it('更晚一次点击发起后，先前那次的结果不注入', async () => {
    const pending: Array<(outcome: TranslateOutcome) => void> = []
    const { action, setOverlay } = harness({
      translate: () =>
        new Promise<TranslateOutcome>((resolve) => {
          pending.push(resolve)
        }),
    })

    action.trigger({ displayId: 7, region: REGION })
    // 第二次点击：代次前进，第一次的结果随即作废。
    action.trigger({ displayId: 7, region: REGION })
    const outcome: TranslateOutcome = { kind: 'translated', displayId: 7, region: REGION, blocks: BLOCKS }

    pending[0]?.(outcome)
    await settle()
    expect(setOverlay).not.toHaveBeenCalled()

    // 后发起的那次落地，且只落地一次。
    pending[1]?.(outcome)
    await settle()
    expect(setOverlay).toHaveBeenCalledTimes(1)
  })

  it('翻译被跳过（无锁定等）时不装配计划', async () => {
    const { action, compose, setOverlay } = harness({
      translate: async () => ({ kind: 'skipped', reason: 'no-lock' }),
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(compose).not.toHaveBeenCalled()
    expect(setOverlay).not.toHaveBeenCalled()
  })

  it('目标覆盖窗已不在时不注入且出声', async () => {
    const { action, warn } = harness({ overlays: [] })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('覆盖窗已不在'))
  })

  it('覆盖窗已销毁时不注入', async () => {
    const dead = sink(7, true)
    const { action } = harness({ overlays: [dead.handle] })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(dead.setOverlay).not.toHaveBeenCalled()
  })

  it('读设置抛错时不炸进程，只记一条告警', async () => {
    const warn = vi.fn()
    const action = createRegionLockAction({
      readSettings: () => {
        throw new Error('设置文件不可读')
      },
      translate: vi.fn(),
      compose: vi.fn(),
      overlays: () => [],
      gate: createLatestGate(),
      logger: { info: vi.fn(), warn, error: vi.fn() },
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('设置文件不可读'))
  })
})

describe('createRegionLockAction：loading 的生命周期', () => {
  it('发起后立刻在锁定区域显示扫描线', async () => {
    const { action, setLoading } = harness()

    action.trigger({ displayId: 7, region: REGION })
    // 显示发生在链路首个 await 之前：不等 settle 就该已经显示。
    expect(setLoading).toHaveBeenCalledTimes(1)
    expect(setLoading).toHaveBeenCalledWith(REGION)

    await settle()
    expect(setLoading).toHaveBeenCalledTimes(1)
  })

  it('正常落地后扫描线收掉（时机一）', async () => {
    const { action, setOverlay, setLoading, clearLoading } = harness()

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(setOverlay).toHaveBeenCalledTimes(1)
    expect(clearLoading).toHaveBeenCalledTimes(1)
    expect(clearLoading).toHaveBeenCalledWith(REGION)
    expect(setLoading).toHaveBeenCalledTimes(1)
  })

  it('被更晚的点击取代时，前一轮收线、后一轮正常走完（时机二）', async () => {
    const pending: Array<(outcome: TranslateOutcome) => void> = []
    const { action, setOverlay, setLoading, clearLoading } = harness({
      translate: () =>
        new Promise<TranslateOutcome>((resolve) => {
          pending.push(resolve)
        }),
    })

    action.trigger({ displayId: 7, region: REGION })
    // 第二次点击：代次前进，第一次的结果随即作废（同步连发即「素材后到」型交错，
    // 第一轮在读设置并显示后被淘汰是闸门正确行为）。
    action.trigger({ displayId: 7, region: REGION })

    expect(setLoading).toHaveBeenCalledTimes(2)
    expect(clearLoading).not.toHaveBeenCalled()

    const outcome: TranslateOutcome = { kind: 'translated', displayId: 7, region: REGION, blocks: BLOCKS }
    pending[0]?.(outcome)
    await settle()
    // 前一轮在「被取代」检查点离开链路：对自己的区域发起收线、覆盖不注入。
    // 两轮的 region 相同，逻辑层只能断言「各链收自己的区域」；「旧区域收线动不到
    // 新区域的线」由渲染层（overlay-dom 的归属判定用例）钉住，两层合起来语义才完整。
    expect(clearLoading).toHaveBeenCalledTimes(1)
    expect(clearLoading).toHaveBeenCalledWith(REGION)
    expect(setOverlay).not.toHaveBeenCalled()

    pending[1]?.(outcome)
    await settle()
    expect(setOverlay).toHaveBeenCalledTimes(1)
    expect(clearLoading).toHaveBeenCalledTimes(2)
    expect(clearLoading).toHaveBeenCalledWith(REGION)
  })

  it('冻结退出（invalidate）后，在途轮离开链路时收线（时机四）', async () => {
    const pending: Array<(outcome: TranslateOutcome) => void> = []
    const { action, setOverlay, setLoading, clearLoading } = harness({
      translate: () =>
        new Promise<TranslateOutcome>((resolve) => {
          pending.push(resolve)
        }),
    })

    action.trigger({ displayId: 7, region: REGION })
    expect(setLoading).toHaveBeenCalledTimes(1)

    // 控制器 exit 对翻译动作的作废经这里到达：在途轮整体不再落地。
    action.invalidate()

    pending[0]?.({ kind: 'translated', displayId: 7, region: REGION, blocks: BLOCKS })
    await settle()

    expect(clearLoading).toHaveBeenCalledTimes(1)
    expect(clearLoading).toHaveBeenCalledWith(REGION)
    expect(setOverlay).not.toHaveBeenCalled()
  })

  it('链路抛错时收线（时机三）', async () => {
    const { action, clearLoading, warn } = harness({
      translate: async () => {
        throw new Error('OCR 服务不可用')
      },
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(clearLoading).toHaveBeenCalledTimes(1)
    expect(clearLoading).toHaveBeenCalledWith(REGION)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OCR 服务不可用'))
  })

  it('翻译被跳过时也收线（丢弃即消失）', async () => {
    const { action, compose, clearLoading } = harness({
      translate: async () => ({ kind: 'skipped', reason: 'no-lock' }),
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(compose).not.toHaveBeenCalled()
    expect(clearLoading).toHaveBeenCalledTimes(1)
    expect(clearLoading).toHaveBeenCalledWith(REGION)
  })

  it('目标屏没有覆盖窗时不显示也不隐藏', async () => {
    const { action, setLoading, clearLoading } = harness({ overlays: [] })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(setLoading).not.toHaveBeenCalled()
    expect(clearLoading).not.toHaveBeenCalled()
  })

  it('链路途中覆盖窗被销毁：显示过、但收线时不再触碰', async () => {
    let destroyed = false
    const setLoading = vi.fn()
    const clearLoading = vi.fn()
    const handle: OverlaySink = {
      displayId: 7,
      isDestroyed: () => destroyed,
      setOverlay: vi.fn(),
      setLoading,
      clearLoading,
    }
    const pending: Array<(outcome: TranslateOutcome) => void> = []
    const action = createRegionLockAction({
      readSettings: () => withSettings({}),
      translate: () =>
        new Promise<TranslateOutcome>((resolve) => {
          pending.push(resolve)
        }),
      compose: vi.fn(),
      overlays: () => [handle],
      gate: createLatestGate(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    action.trigger({ displayId: 7, region: REGION })
    expect(setLoading).toHaveBeenCalledTimes(1)

    // 用户按了 Escape：窗口销毁，DOM 已随之消失，收线是多余的触碰。
    destroyed = true
    pending[0]?.({ kind: 'translated', displayId: 7, region: REGION, blocks: BLOCKS })
    await settle()

    expect(clearLoading).not.toHaveBeenCalled()
  })

  it('两个开关全关时不发起链路也不显示扫描线', async () => {
    const { action, setLoading, clearLoading } = harness({
      settings: withSettings({ translateText: false, translateCharts: false }),
    })

    action.trigger({ displayId: 7, region: REGION })
    await settle()

    expect(setLoading).not.toHaveBeenCalled()
    expect(clearLoading).not.toHaveBeenCalled()
  })

  it('invalidate 使在途号过期，后续放行不再落地', async () => {
    const pending: Array<(outcome: TranslateOutcome) => void> = []
    const { action, gate, setOverlay } = harness({
      translate: () =>
        new Promise<TranslateOutcome>((resolve) => {
          pending.push(resolve)
        }),
    })

    const token = gate.begin()
    action.trigger({ displayId: 7, region: REGION })
    action.invalidate()

    expect(gate.isCurrent(token)).toBe(false)
    pending[0]?.({ kind: 'translated', displayId: 7, region: REGION, blocks: BLOCKS })
    await settle()

    expect(setOverlay).not.toHaveBeenCalled()
  })
})
