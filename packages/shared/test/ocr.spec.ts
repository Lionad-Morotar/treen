import { describe, expect, it, vi } from 'vitest'
import {
  createOcrReader,
  dataUrlToBytes,
  normalizedRoi,
  readingOrder,
  type OcrObservation,
  type Rect,
} from '../src/translation/ocr'

const display = { bounds: { x: 0, y: 0, width: 400, height: 200 } }

function frame(dataUrl = 'data:image/png;base64,AAAA') {
  return { dataUrl }
}

function obs(text: string, boundingBox: Rect, confidence = 0.9): OcrObservation {
  return { text, confidence, boundingBox }
}

describe('readingOrder', () => {
  it('按 y 再按 x 排序，不看输入次序', () => {
    const unordered = [
      obs('右下', { x: 0.5, y: 0.6, width: 0.1, height: 0.05 }),
      obs('左上', { x: 0.1, y: 0.2, width: 0.1, height: 0.05 }),
      obs('右上', { x: 0.5, y: 0.2, width: 0.1, height: 0.05 }),
    ]

    expect(readingOrder(unordered).map((item) => item.text)).toEqual(['左上', '右上', '右下'])
  })

  it('不改动入参数组，返回新数组', () => {
    const input = [obs('b', { x: 0, y: 0.5, width: 0.1, height: 0.05 }), obs('a', { x: 0, y: 0.1, width: 0.1, height: 0.05 })]

    const sorted = readingOrder(input)

    expect(sorted.map((item) => item.text)).toEqual(['a', 'b'])
    expect(input.map((item) => item.text)).toEqual(['b', 'a'])
  })

  it('空输入得到空数组', () => {
    expect(readingOrder([])).toEqual([])
  })
})

describe('normalizedRoi', () => {
  it('把显示器相对 DIP 选区换算成归一化 ROI', () => {
    expect(normalizedRoi({ x: 100, y: 50, width: 200, height: 100 }, display)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    })
  })

  it('越界部分钳到 [0,1]，x+width 不超过 1', () => {
    const roi = normalizedRoi({ x: -50, y: 180, width: 500, height: 100 }, display)

    expect(roi).not.toBeNull()
    expect(roi?.x).toBe(0)
    expect(roi?.y).toBeCloseTo(0.9)
    expect(roi?.width).toBe(1)
    expect(roi?.height).toBeCloseTo(0.1)
  })

  it('非有限坐标或退化尺寸返回 null，不把坏值喂给原生层', () => {
    expect(normalizedRoi({ x: Number.NaN, y: 0, width: 10, height: 10 }, display)).toBeNull()
    expect(normalizedRoi({ x: 10, y: 10, width: 0, height: 10 }, display)).toBeNull()
  })
})

describe('dataUrlToBytes', () => {
  it('剥掉 data URL 前缀并解出字节', () => {
    expect([...dataUrlToBytes('data:image/png;base64,AAAA')]).toEqual([0, 0, 0])
  })

  it('没有逗号分隔的非法 data URL 抛错', () => {
    expect(() => dataUrlToBytes('notadataurl')).toThrow()
  })
})

describe('createOcrReader', () => {
  it('按 ROI 识别并把归一化框映射回显示器相对 DIP，输出按阅读序', async () => {
    const recognize = vi.fn(async () => ({
      observations: [
        obs('下', { x: 0.1, y: 0.5, width: 0.25, height: 0.5 }),
        obs('上', { x: 0.5, y: 0.2, width: 0.25, height: 0.25 }),
      ],
    }))
    const reader = createOcrReader({ recognize })
    const region: Rect = { x: 100, y: 50, width: 200, height: 100 }

    const blocks = await reader(frame(), region, display)

    expect(recognize).toHaveBeenCalledTimes(1)
    const [bytes, roi] = recognize.mock.calls[0] as unknown as [Uint8Array, Rect]
    expect([...bytes]).toEqual([0, 0, 0])
    expect(roi).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })

    expect(blocks.map((block) => block.text)).toEqual(['上', '下'])
    expect(blocks[0]?.box).toEqual({ x: 100 + 0.5 * 200, y: 50 + 0.2 * 100, width: 0.25 * 200, height: 0.25 * 100 })
  })

  it('没有识别到文字时返回空数组', async () => {
    const reader = createOcrReader({ recognize: async () => ({ observations: [] }) })

    expect(await reader(frame(), { x: 0, y: 0, width: 400, height: 200 }, display)).toEqual([])
  })

  it('ROI 换算不出有效区域时抛错，不把坏 ROI 交给原生层', async () => {
    const recognize = vi.fn()
    const reader = createOcrReader({ recognize })

    await expect(
      reader(frame(), { x: 900, y: 900, width: 100, height: 100 }, display),
    ).rejects.toThrow()
    expect(recognize).not.toHaveBeenCalled()
  })

  it('越界选区被钳制后，落点按钳制矩形而非原选区换算', async () => {
    // 识别只覆盖钳制后的 ROI（左边界外的 100 DIP 被切掉），落点也必须收窄到同一矩形，
    // 否则译文会整片右移出选区。
    const recognize = vi.fn(async () => ({
      observations: [obs('x', { x: 0.5, y: 0.5, width: 0.1, height: 0.1 })],
    }))
    const reader = createOcrReader({ recognize })

    const blocks = await reader(frame(), { x: -100, y: 0, width: 400, height: 200 }, display)

    // 钳制后 ROI 宽 300（0–0.75×400）：0.5 落在 150，而不是未钳制的 −100 + 0.5×400 = 100。
    expect(blocks[0]?.box).toEqual({ x: 150, y: 100, width: 30, height: 20 })
  })

  it('右越界同样按钳制矩形换算，落点不越过屏右缘', async () => {
    const recognize = vi.fn(async () => ({
      observations: [obs('x', { x: 0.8, y: 0.5, width: 0.2, height: 0.1 })],
    }))
    const reader = createOcrReader({ recognize })

    // 选区右端越出 100 DIP：ROI 宽钳成 100（0.75–1.0），映射便不再按未钳制的 200 展开。
    const blocks = await reader(frame(), { x: 300, y: 0, width: 200, height: 200 }, display)

    const box = blocks[0]?.box
    expect(box).toEqual({ x: 380, y: 100, width: 20, height: 20 })
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(400)
  })

  it('下越界同样按钳制矩形换算，落点不越过屏下缘', async () => {
    const recognize = vi.fn(async () => ({
      observations: [obs('x', { x: 0.5, y: 0.9, width: 0.1, height: 0.1 })],
    }))
    const reader = createOcrReader({ recognize })

    // 选区下端越出 100 DIP：ROI 高钳成 100（0.5–1.0），同一 bbox 的落点随之收窄到屏下缘内。
    const blocks = await reader(frame(), { x: 0, y: 100, width: 400, height: 200 }, display)

    const box = blocks[0]?.box
    expect(box).toEqual({ x: 200, y: 190, width: 40, height: 10 })
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(200)
  })
})
