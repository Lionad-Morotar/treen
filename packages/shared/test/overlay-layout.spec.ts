import { describe, expect, it } from 'vitest'
import {
  LINE_HEIGHT_RATIO,
  MIN_FONT_SIZE,
  fitChartIntoBox,
  fitTextIntoBox,
  planOverlay,
  wrapText,
} from '../src/overlay/layout'

describe('wrapText：按可用宽度与字号折行', () => {
  it('全角字符按 1em 计、半角按 0.602em 计，宽度够就不折', () => {
    // 100px / 16px = 6.25em，两个汉字 2em 放得下。
    expect(wrapText('中文', 100, 16)).toEqual(['中文'])
  })

  it('超宽即折行，且不丢字符', () => {
    // 100px / 10px = 10em，20 个汉字折成两行。
    const lines = wrapText('一'.repeat(20), 100, 10)
    expect(lines).toEqual(['一'.repeat(10), '一'.repeat(10)])
    expect(lines.join('')).toHaveLength(20)
  })

  it('显式换行符断行，不参与宽度累加', () => {
    expect(wrapText('上\n下', 100, 16)).toEqual(['上', '下'])
  })

  it('空串产出一行空串，不产出零行', () => {
    expect(wrapText('', 100, 16)).toEqual([''])
  })
})

describe('fitTextIntoBox：字号自适应、长文折行、不溢出', () => {
  it('短文本用盒高允许的最大字号，单行填满盒高而不被放大越界', () => {
    const placement = fitTextIntoBox('中文', { x: 0, y: 0, width: 100, height: 20 })

    // 上限 = 盒高 / 行距 = 20 / 1.25 = 16。
    expect(placement?.fontSize).toBe(16)
    expect(placement?.lines).toEqual(['中文'])
    expect(placement?.clipped).toBe(false)
    expect(placement?.lineHeight).toBeCloseTo(16 * LINE_HEIGHT_RATIO)
  })

  it('长文折行到盒高之内，字号随之缩小', () => {
    const placement = fitTextIntoBox('一'.repeat(20), { x: 0, y: 0, width: 100, height: 40 })

    expect(placement?.fontSize).toBe(10)
    expect(placement?.lines).toHaveLength(2)
    expect(placement?.clipped).toBe(false)
    // 折行后总高不超盒高。
    expect((placement?.lines.length ?? 0) * (placement?.lineHeight ?? 0)).toBeLessThanOrEqual(40)
  })

  it('折行的每行宽度都不超盒宽', () => {
    const placement = fitTextIntoBox('中'.repeat(30), { x: 0, y: 0, width: 80, height: 60 })
    expect(placement).not.toBeNull()
    const perChar = (placement?.fontSize ?? 0) // 全角 1em
    for (const line of placement?.lines ?? []) {
      expect(line.length * perChar).toBeLessThanOrEqual(80)
    }
  })

  it('达最小字号仍放不下时标记 clipped，字号停在下限而不是趋近于零', () => {
    // 盒高只有一行、盒子又窄，长文本无论如何都放不下。
    const placement = fitTextIntoBox('一'.repeat(40), { x: 0, y: 0, width: 40, height: 10 })

    expect(placement?.clipped).toBe(true)
    expect(placement?.fontSize).toBe(MIN_FONT_SIZE)
    expect(placement?.lines.length).toBeGreaterThan(0)
  })

  it('退化盒（零宽或零高）返回 null，不产出空盒', () => {
    expect(fitTextIntoBox('中文', { x: 0, y: 0, width: 0, height: 20 })).toBeNull()
    expect(fitTextIntoBox('中文', { x: 0, y: 0, width: 100, height: 0 })).toBeNull()
    expect(fitTextIntoBox('中文', { x: NaN, y: 0, width: 100, height: 20 })).toBeNull()
  })

  it('盒尺寸与位置原样带出，字号只改内部', () => {
    const placement = fitTextIntoBox('中文', { x: 12, y: 34, width: 100, height: 20 })
    expect(placement).toMatchObject({ x: 12, y: 34, width: 100, height: 20 })
  })
})

describe('fitChartIntoBox：contain 适配并居中', () => {
  it('宽图入竖框：缩到框宽，上下留白居中，不裁剪', () => {
    const fitted = fitChartIntoBox({ width: 900, height: 260 }, { x: 10, y: 20, width: 520, height: 460 })

    expect(fitted?.width).toBeCloseTo(520)
    expect(fitted?.height).toBeCloseTo((260 * 520) / 900)
    expect(fitted?.x).toBeCloseTo(10)
    expect(fitted?.y).toBeCloseTo(20 + (460 - (260 * 520) / 900) / 2)
  })

  it('方图入扁框：缩到框高，左右留白居中', () => {
    const fitted = fitChartIntoBox({ width: 600, height: 600 }, { x: 0, y: 0, width: 800, height: 200 })

    expect(fitted?.width).toBeCloseTo(200)
    expect(fitted?.height).toBeCloseTo(200)
    expect(fitted?.x).toBeCloseTo(300)
    expect(fitted?.y).toBeCloseTo(0)
  })

  it('比例一致时恰好填满，不留白', () => {
    const fitted = fitChartIntoBox({ width: 800, height: 300 }, { x: 5, y: 6, width: 400, height: 150 })

    expect(fitted).toEqual({ x: 5, y: 6, width: 400, height: 150 })
  })

  it('退化固有尺寸或退化盒返回 null', () => {
    expect(fitChartIntoBox({ width: 0, height: 100 }, { x: 0, y: 0, width: 100, height: 100 })).toBeNull()
    expect(fitChartIntoBox({ width: 100, height: 100 }, { x: 0, y: 0, width: 0, height: 100 })).toBeNull()
  })
})

describe('planOverlay：译文与图同屏共存', () => {
  const chart = {
    svg: '<svg viewBox="0 0 100 100"></svg>',
    intrinsic: { width: 100, height: 100 },
    box: { x: 200, y: 200, width: 200, height: 200 },
  }

  it('图区域内的译文被让位，区域外的译文照常覆盖', () => {
    const plan = planOverlay({
      charts: [chart],
      texts: [
        { translation: '在图里', box: { x: 250, y: 250, width: 80, height: 20 } },
        { translation: '在图外', box: { x: 10, y: 10, width: 80, height: 20 } },
      ],
    })

    expect(plan.charts).toHaveLength(1)
    expect(plan.texts.map((text) => text.lines.join(''))).toEqual(['在图外'])
  })

  it('携带字体栈与行距，供渲染层落样式', () => {
    const plan = planOverlay({ texts: [], charts: [] })
    expect(plan.fontFamily).toContain('monospace')
    expect(plan.lineHeightRatio).toBe(LINE_HEIGHT_RATIO)
  })

  it('退化盒的译文与图各自被丢弃，不影响另一方', () => {
    const plan = planOverlay({
      charts: [{ ...chart, intrinsic: { width: 0, height: 0 } }],
      texts: [
        { translation: '好盒', box: { x: 0, y: 0, width: 80, height: 20 } },
        { translation: '坏盒', box: { x: 0, y: 0, width: 80, height: 0 } },
      ],
    })

    expect(plan.charts).toHaveLength(0)
    expect(plan.texts.map((text) => text.lines.join(''))).toEqual(['好盒'])
  })
})
