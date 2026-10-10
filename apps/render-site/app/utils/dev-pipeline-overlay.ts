/**
 * 覆盖层预览的换算与图表源码还原（纯逻辑，不碰 DOM）。
 *
 * 存在理由是两类静默错位：覆盖计划的坐标是**图像像素**，而页面里的原图按 CSS 宽度缩放显示，
 * 不换算比例就整体偏移；浏览器侧要拿同一段源码重渲一遍才比得出「服务端为什么没渲出来」，
 * 源码取错行则两侧比的不是同一张图。两件事都不抛错，故单独立在页面之外被验证。
 */

/** 覆盖计划里的矩形：图像像素、左上原点。 */
export interface OverlayBox {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayTextItem extends OverlayBox {
  translation: string
  /** 已按盒宽折好的行；预览逐行输出，不重做折行 */
  lines: string[]
  fontSize: number
  lineHeight: number
  /** 到最小字号仍放不下：预览侧按裁剪呈现 */
  clipped: boolean
}

export interface OverlayChartItem extends OverlayBox {
  svg: string
  intrinsic: { width: number; height: number }
}

/** 覆盖层预览的三种视图：只看原图、只看覆盖层、两者叠加。 */
export type OverlayView = 'source' | 'overlay' | 'both'

export const OVERLAY_VIEWS: ReadonlyArray<{ value: OverlayView; label: string }> = [
  { value: 'source', label: '原图' },
  { value: 'overlay', label: '覆盖层' },
  { value: 'both', label: '叠加' },
]

/**
 * 定位样式。
 *
 * 写成类型别名而不是 interface：Vue 的 CSSProperties 带 `--${string}` 索引签名，而 interface
 * 没有隐式索引签名、过不去它的可赋值检查；别名形式的同形对象类型则会被补上隐式索引签名。
 * 这里产出的对象就是直接喂给 `:style` 的，不为它再包一层转换。
 */
export type OverlayStyle = {
  left: string
  top: string
  width: string
  height: string
}

export type OverlayTextStyle = OverlayStyle & {
  fontSize: string
  lineHeight: string
}

function px(value: number): string {
  return `${value}px`
}

/**
 * 原图的显示比例：显示宽度 / 原始像素宽度。
 *
 * 原始宽度拿不到时（图还没解码）退回 1 而不是 0 或 NaN——NaN 会让整片覆盖层在浏览器里静默
 * 塌陷，而按 1 落点最多是没缩放时的错位，至少还看得见东西。
 */
export function overlayScaleOf(displayWidth: number, naturalWidth: number): number {
  if (!Number.isFinite(displayWidth) || !Number.isFinite(naturalWidth) || naturalWidth <= 0) {
    return 1
  }
  return displayWidth / naturalWidth
}

/** 按显示比例把像素矩形换成绝对定位样式。 */
export function overlayStyleOf(box: OverlayBox, scale: number): OverlayStyle {
  return {
    left: px(box.x * scale),
    top: px(box.y * scale),
    width: px(box.width * scale),
    height: px(box.height * scale),
  }
}

/** 译文盒额外带字号：字号是像素语义，同样随显示比例缩放，否则折行与盒宽不再匹配。 */
export function overlayTextStyleOf(text: OverlayTextItem, scale: number): OverlayTextStyle {
  return {
    ...overlayStyleOf(text, scale),
    fontSize: px(text.fontSize * scale),
    lineHeight: px(text.lineHeight * scale),
  }
}

function containsCenter(box: OverlayBox, candidate: OverlayBox): boolean {
  const centerX = candidate.x + candidate.width / 2
  const centerY = candidate.y + candidate.height / 2
  return (
    centerX >= box.x &&
    centerX <= box.x + box.width &&
    centerY >= box.y &&
    centerY <= box.y + box.height
  )
}

/**
 * 还原一张图的源码：取中心落在图版位内的观察行，按行序以换行拼接。
 *
 * 以中心点归属为准而非任意交叠——相邻正文的行盒常与图版位边贴边甚至轻微相交，按交叠取会把
 * 正文混进源码，渲染站随后拒掉这段非法源码，浏览器侧于是渲不出图，对比结论被自己制造的差异
 * 污染。行序沿用 OCR 的返回次序（装配层也是按此序拼源码文本）。
 */
export function chartSourceOf(
  blocks: ReadonlyArray<{ text: string; box: OverlayBox }>,
  chart: OverlayBox,
): string {
  return blocks
    .filter((block) => containsCenter(chart, block.box))
    .map((block) => block.text)
    .join('\n')
}

/** 逐张图还原源码，结果与服务端的 `plan.charts` 同序，便于按索引并列对比。 */
export function chartSourcesOf(
  blocks: ReadonlyArray<{ text: string; box: OverlayBox }>,
  charts: readonly OverlayChartItem[],
): string[] {
  // 版位自身就是扁平的矩形（与覆盖计划的 TextPlacement/ChartPlacement 同形），直接当矩形用。
  return charts.map((chart) => chartSourceOf(blocks, chart))
}
