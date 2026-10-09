import { describe, expect, it, vi } from 'vitest'
import { createLatestGate } from '../src/overlay/latest-gate'
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

/** 两个开关都开的一份完整设置；本文件只关心开关，热键取一个占位值。 */
const SETTINGS: TreenSettings = {
  freezeAccelerator: 'Alt+T',
  translateText: true,
  translateCharts: true,
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
  const handle: OverlaySink = { displayId, isDestroyed: () => destroyed, setOverlay }
  return { handle, setOverlay }
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
  const action = createRegionLockAction({
    readSettings: () => overrides.settings ?? withSettings({}),
    translate,
    compose,
    overlays: () => overrides.overlays ?? [target.handle],
    gate: createLatestGate(),
    logger: { info, warn, error: vi.fn() },
  })
  return { action, translate, compose, setOverlay: target.setOverlay, warn, info }
}

/** 等到 action 内部的异步链路跑完（fire-and-forget，测试需显式等待）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('createRegionLockAction：两个开关的门控', () => {
  it('两项都开：翻译与图表都走，计划原样注入', async () => {
    const { action, translate, compose, setOverlay } = harness()

    action({ displayId: 7, region: REGION })
    await settle()

    expect(translate).toHaveBeenCalledWith(7, { translateText: true })
    expect(compose).toHaveBeenCalledWith(BLOCKS, REGION, { texts: true, charts: true })
    expect(setOverlay).toHaveBeenCalledTimes(1)
  })

  it('关文本开图表：仍识别（OCR 在图链路里要用），但翻译调用被标记跳过，计划只要图', async () => {
    const { action, translate, compose, setOverlay } = harness({
      settings: withSettings({ translateText: false }),
    })

    action({ displayId: 7, region: REGION })
    await settle()

    expect(translate).toHaveBeenCalledWith(7, { translateText: false })
    expect(compose).toHaveBeenCalledWith(BLOCKS, REGION, { texts: false, charts: true })
    expect(setOverlay).toHaveBeenCalledTimes(1)
  })

  it('开文本关图表：要译文不要图', async () => {
    const { action, translate, compose } = harness({
      settings: withSettings({ translateCharts: false }),
    })

    action({ displayId: 7, region: REGION })
    await settle()

    expect(translate).toHaveBeenCalledWith(7, { translateText: true })
    expect(compose).toHaveBeenCalledWith(BLOCKS, REGION, { texts: true, charts: false })
  })

  it('两项都关：一次触发什么都不做，连翻译都不发起', async () => {
    const { action, translate, compose, setOverlay, info } = harness({
      settings: withSettings({ translateText: false, translateCharts: false }),
    })

    action({ displayId: 7, region: REGION })
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

    action({ displayId: 7, region: REGION })
    // 第二次点击：代次前进，第一次的结果随即作废。
    action({ displayId: 7, region: REGION })
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

    action({ displayId: 7, region: REGION })
    await settle()

    expect(compose).not.toHaveBeenCalled()
    expect(setOverlay).not.toHaveBeenCalled()
  })

  it('目标覆盖窗已不在时不注入且出声', async () => {
    const { action, warn } = harness({ overlays: [] })

    action({ displayId: 7, region: REGION })
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('覆盖窗已不在'))
  })

  it('覆盖窗已销毁时不注入', async () => {
    const dead = sink(7, true)
    const { action } = harness({ overlays: [dead.handle] })

    action({ displayId: 7, region: REGION })
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

    action({ displayId: 7, region: REGION })
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('设置文件不可读'))
  })
})
