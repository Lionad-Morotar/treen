import { describe, expect, it, vi } from 'vitest'
import { createTranslateSelection } from '../src/translation/link'
import type { OcrEngine } from '../src/translation/ocr'
import type { DisplayLike, Rect } from '../src/freeze/geometry'
import type { FreezeFrame, SelectionSource } from '../src/freeze/controller'

const display: DisplayLike = {
  id: 1,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 400, height: 200 },
}

function frame(): FreezeFrame {
  return { id: 'src', displayId: '1', size: { width: 800, height: 400 }, dataUrl: 'data:image/png;base64,AAAA' }
}

function source(locked: Rect | null): SelectionSource {
  return { display, frame: frame(), locked }
}

const LOCKED: Rect = { x: 100, y: 50, width: 200, height: 100 }

const recognizing: OcrEngine = async () => ({
  observations: [
    { text: '下', confidence: 0.9, boundingBox: { x: 0.1, y: 0.5, width: 0.25, height: 0.5 } },
    { text: '上', confidence: 0.9, boundingBox: { x: 0.5, y: 0.2, width: 0.25, height: 0.25 } },
  ],
})

function harness(overrides: Partial<Parameters<typeof createTranslateSelection>[0]> = {}) {
  const translate = vi.fn(async (texts: readonly string[]) => texts.map((text) => `译:${text}`))
  const warn = vi.fn()
  const info = vi.fn()
  const action = createTranslateSelection({
    readSources: async () => [source(LOCKED)],
    recognize: recognizing,
    translate,
    logger: { info, warn, error: vi.fn() },
    ...overrides,
  })
  return { action, translate, warn, info }
}

describe('createTranslateSelection', () => {
  it('没有覆盖窗时跳过，不发起翻译', async () => {
    const { action, translate, warn } = harness({ readSources: async () => [] })

    expect(await action()).toEqual({ kind: 'skipped', reason: 'no-window' })
    expect(translate).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('没有锁定选区时跳过，不把整屏送去翻译', async () => {
    const { action, translate } = harness({ readSources: async () => [source(null)] })

    expect(await action()).toEqual({ kind: 'skipped', reason: 'no-lock' })
    expect(translate).not.toHaveBeenCalled()
  })

  it('选区没识别到文字时跳过', async () => {
    const { action, translate } = harness({ recognize: async () => ({ observations: [] }) })

    expect(await action()).toEqual({ kind: 'skipped', reason: 'no-text' })
    expect(translate).not.toHaveBeenCalled()
  })

  it('把阅读序的原文送翻译，译文连同屏幕落点一起返回', async () => {
    const { action, translate } = harness()

    const outcome = await action()

    expect(translate).toHaveBeenCalledWith(['上', '下'])
    expect(outcome).toEqual({
      kind: 'translated',
      displayId: 1,
      region: LOCKED,
      blocks: [
        { source: '上', translation: '译:上', box: { x: 200, y: 70, width: 50, height: 25 } },
        { source: '下', translation: '译:下', box: { x: 120, y: 100, width: 50, height: 50 } },
      ],
    })
  })

  it('翻译实现返回条数与原文不符即抛错，不交出错位的译文', async () => {
    const { action } = harness({ translate: async () => ['只有一条'] })

    await expect(action()).rejects.toThrow(/不一致/)
  })
})
