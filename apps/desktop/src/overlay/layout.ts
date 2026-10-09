import { MONOSPACE_FONT_FAMILY, advanceEm } from '@treen/shared/text-metrics'
import { intersectRects } from '../highlight/candidates'
import type { Rect } from '../freeze/geometry'

/**
 * 覆盖层布局引擎（纯逻辑）：把「一段译文」「一张图」换算成绝对定位的渲染盒。
 *
 * 坐标与候选区域同一约定——显示器相对 DIP，可原样作为绝对定位元素的 left/top/width/height。
 * 这里只做几何与折行计算，不碰 DOM：渲染层（overlay.html）拿到算好的盒子直接落样式，
 * 于是「字号自适应」「折行不溢出」「contain 居中」这些判据都能在纯 Node 下被单测覆盖。
 *
 * 译文与图表职责不同：
 * - 译文用 contain 语义：字号在包围盒内自适应，超宽即折行，绝不横向溢出；到下限仍放不下才裁剪。
 * - 图表用 contain + 居中：等比缩放到包围盒内取小者，四周留白，不裁剪（图被裁等于丢内容）。
 */

/** 译文行距相对字号的倍数。等宽字体下 1.25 是常见的可读行距。 */
export const LINE_HEIGHT_RATIO = 1.25

/**
 * 译文字号下限。低于此值文字已不可辨，继续缩小不如裁剪——把「尽量放下」与「保持可读」
 * 的分界固定成一个显式常量，而不是让字号无限趋近于零。
 */
export const MIN_FONT_SIZE = 6

/** 一段译文的布局：渲染层按这些数落绝对定位与 font-size。 */
export interface TextPlacement {
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  /** 行高（px）= fontSize × LINE_HEIGHT_RATIO */
  lineHeight: number
  /** 已按 width 折好的行；渲染层逐行输出，不重做换行 */
  lines: string[]
  /** 达最小字号仍放不下：渲染时按裁剪呈现（overflow: hidden），不越界 */
  clipped: boolean
}

/** 一张图的布局：把 SVG 缩到 contain 后的矩形。 */
export interface ChartPlacement {
  x: number
  y: number
  width: number
  height: number
  /** 渲染站直出的 SVG 串；尺寸由 width/height 承载，SVG 自身按 viewBox 缩放 */
  svg: string
}

export interface Size {
  width: number
  height: number
}

function isPositiveBox(box: Rect): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  )
}

function isPositiveSize(size: Size): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0
}

/** 两个矩形是否有正面积交叠。边贴边不算交叠。 */
function overlaps(a: Rect, b: Rect): boolean {
  const hit = intersectRects(a, b)
  return hit.width > 0 && hit.height > 0
}

/**
 * 按可用宽度与字号把文本折行。
 *
 * 折行以字符为最小单位——不拆词：等宽字体下 CJK 逐字断行是自然的，拉丁词被断开也只影响观感，
 * 而引入词边界会让折行结果依赖一套正则需要维护。渲染层直接用这里折好的行，两侧不会各折一次。
 */
export function wrapText(text: string, maxWidthPx: number, fontSize: number): string[] {
  const maxEm = maxWidthPx / fontSize
  const lines: string[] = []
  let current = ''
  let currentEm = 0
  for (const char of text) {
    if (char === '\n') {
      lines.push(current)
      current = ''
      currentEm = 0
      continue
    }
    const em = advanceEm(char)
    if (current !== '' && currentEm + em > maxEm) {
      lines.push(current)
      current = char
      currentEm = em
    } else {
      current += char
      currentEm += em
    }
  }
  if (current !== '' || lines.length === 0) {
    lines.push(current)
  }
  return lines
}

/**
 * 给定字号，折好的文本能否完整放进盒子。
 *
 * 高度必判：行数 × 行高 ≤ 盒高。宽度基本由折行保证（每行 em ≤ 盒宽/字号），只有单个字符
 * 本身就宽过盒子时才会触到——补一道行宽校验把这唯一缺口堵上。
 */
function fitsBox(lines: readonly string[], fontSize: number, box: Rect): boolean {
  if (lines.length * fontSize * LINE_HEIGHT_RATIO > box.height + 1e-6) {
    return false
  }
  const widest = lines.reduce((max, line) => Math.max(max, advanceEm(line)), 0)
  return widest * fontSize <= box.width + 1e-6
}

/**
 * 把一段译文放进包围盒：在 [MIN_FONT_SIZE, 盒高/行距] 里二分出能完整放下的最大整数字号。
 *
 * 判据随字号单调：字号越大，每行可容字符越少、行数不减而每行更高，需要的高度只增不减。
 * 因此「放得下」在字号轴上是一段前缀，二分可拿到确定的最大值。上限取盒高/行距，使短译文
 * 填满盒高而不会被放大到超出原始行高。
 */
export function fitTextIntoBox(text: string, box: Rect): TextPlacement | null {
  if (!isPositiveBox(box)) {
    return null
  }
  const upper = Math.max(MIN_FONT_SIZE, Math.floor(box.height / LINE_HEIGHT_RATIO))
  let bestSize: number | null = null
  let bestLines: string[] = []
  let low = MIN_FONT_SIZE
  let high = upper
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const lines = wrapText(text, box.width, mid)
    if (fitsBox(lines, mid, box)) {
      bestSize = mid
      bestLines = lines
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  const size = bestSize ?? MIN_FONT_SIZE
  const lines = bestSize === null ? wrapText(text, box.width, MIN_FONT_SIZE) : bestLines
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    fontSize: size,
    lineHeight: size * LINE_HEIGHT_RATIO,
    lines,
    clipped: bestSize === null,
  }
}

/**
 * 把一张图放进包围盒：等比缩放取「宽比 / 高比」的较小者，缩放后在盒内居中。
 *
 * 不裁剪是硬要求——`graph LR` 这类宽图入竖框时若按 cover 放大，会裁掉上千像素的节点，
 * 直接毁掉可读性（见研究文档 mermaid-overlay-fit）。留白由渲染层透出，不额外铺底色。
 */
export function fitChartIntoBox(intrinsic: Size, box: Rect): Rect | null {
  if (!isPositiveBox(box) || !isPositiveSize(intrinsic)) {
    return null
  }
  const scale = Math.min(box.width / intrinsic.width, box.height / intrinsic.height)
  const width = intrinsic.width * scale
  const height = intrinsic.height * scale
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  }
}

/** 一段待覆盖的译文：translation 是要显示的文本，box 是它在屏幕上的落点。 */
export interface OverlayTextInput {
  translation: string
  box: Rect
}

/** 一张待覆盖的图：svg 是已渲染的源码产物，intrinsic 是其内容固有尺寸，box 是目标区域。 */
export interface OverlayChartInput {
  svg: string
  intrinsic: Size
  box: Rect
}

/** 渲染层一次性消费的覆盖计划。 */
export interface OverlayPlan {
  fontFamily: string
  lineHeightRatio: number
  texts: TextPlacement[]
  charts: ChartPlacement[]
}

/**
 * 汇总一次覆盖：先定图，再定文，文让位于图。
 *
 * 图占住的那块区域里不再单独覆盖译文——两者叠在一起会互相糊住，而图本身已占据该区域。
 * 判定用矩形交叠（图的目标区域，而非缩放后的实际图形）：图四周的留白也属于它的版位。
 */
export function planOverlay(input: {
  texts: readonly OverlayTextInput[]
  charts: readonly OverlayChartInput[]
}): OverlayPlan {
  const charts: ChartPlacement[] = []
  for (const chart of input.charts) {
    const fitted = fitChartIntoBox(chart.intrinsic, chart.box)
    if (fitted !== null) {
      charts.push({ ...fitted, svg: chart.svg })
    }
  }

  const texts: TextPlacement[] = []
  for (const text of input.texts) {
    if (input.charts.some((chart) => overlaps(chart.box, text.box))) {
      continue
    }
    const placement = fitTextIntoBox(text.translation, text.box)
    if (placement !== null) {
      texts.push(placement)
    }
  }

  return { fontFamily: MONOSPACE_FONT_FAMILY, lineHeightRatio: LINE_HEIGHT_RATIO, texts, charts }
}
