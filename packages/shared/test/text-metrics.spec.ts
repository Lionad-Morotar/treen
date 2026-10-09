import { describe, expect, it } from 'vitest'
import {
  FULLWIDTH_ADVANCE_EM,
  HALFWIDTH_ADVANCE_EM,
  MONOSPACE_FONT_FAMILY,
  advanceEm,
  isFullWidthCodePoint,
} from '../src/text-metrics'

describe('text-metrics：等宽字体前进宽度', () => {
  it('半角字符按 0.602em 累加', () => {
    expect(advanceEm('abc')).toBeCloseTo(3 * HALFWIDTH_ADVANCE_EM)
  })

  it('全角字符按 1em 累加', () => {
    expect(advanceEm('中文')).toBe(2 * FULLWIDTH_ADVANCE_EM)
  })

  it('混排逐字符累加', () => {
    expect(advanceEm('a中')).toBeCloseTo(HALFWIDTH_ADVANCE_EM + FULLWIDTH_ADVANCE_EM)
  })

  it('全角判定覆盖 CJK 与全角标点，不误伤 ASCII', () => {
    expect(isFullWidthCodePoint('中'.codePointAt(0) ?? 0)).toBe(true)
    expect(isFullWidthCodePoint('，'.codePointAt(0) ?? 0)).toBe(true)
    expect(isFullWidthCodePoint('a'.codePointAt(0) ?? 0)).toBe(false)
    expect(isFullWidthCodePoint('1'.codePointAt(0) ?? 0)).toBe(false)
  })

  it('字体栈是等宽栈，与度量绑定', () => {
    expect(MONOSPACE_FONT_FAMILY).toContain('monospace')
  })

  it('空串宽度为零', () => {
    expect(advanceEm('')).toBe(0)
  })
})
