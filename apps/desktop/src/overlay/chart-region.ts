import type { Rect } from '../freeze/geometry'

/**
 * 用几何连续性求一块 mermaid 图在屏幕上的矩形。
 *
 * 为什么不能按源码行号归属：OCR 观察与源码行不是一一对应（一行源码可能拆成两三个观察，
 * 也可能合成一个），且多栏布局下同一个 y 桶混着不同栏位的文本——按 startLine..endLine 的
 * 行号区间去挑观察必然错位。正确的信号是空间：一块图在屏幕上连成一片，而栏与栏、块与块之间
 * 有稳定的间距。
 *
 * 做法是从「图声明所在的那个观察」出发向下与横向扩张：能并入的邻近观察必须同时满足
 * 「水平方向与已有区域有重叠」（挡住同行但不同栏的文本）与「垂直间距小于一个行高阈值」
 * （挡住下方相邻的其它块）。阈值为已并入观察高度中位数乘以系数——随字号自适配，不用固定px。
 *
 * 只向下、不向上：声明行就是图的源码文本的首行，锚点之上的行必不属于这张图（顶部紧邻的标题
 * 之类会因间距足够小而被误并，把矩形撑高、把源码喂坏）。这条方向性来自「锚点是声明行」这个
 * 前提，而不是行列映射——行号与观察的对应关系依旧不可靠，这里只用空间。
 */

/** 一条带屏幕落点的 OCR 观察；与识别链路的 OcrBlock 同形（此处只取文字与盒子）。 */
export interface PlacedObservation {
  text: string
  box: Rect
}

export interface ChartRegionOptions {
  /**
   * 归属上界（选区矩形，显示器相对 DIP）。Vision 对 ROI 边界会溢出，ROI 外的相邻文字偶尔
   * 也进 observations；以选区为上界过滤，避免把选区外的字并进图的范围。
   */
  bound?: Rect
  /** 垂直并入阈值系数：间距 < 系数 × 行高中位数 才并入。缺省 1.5。 */
  gapFactor?: number
  /**
   * 边界判据：返回 true 的观察及其以下的观察都归下一块，扩张到此为止。
   *
   * 几何连续性的盲区是「上下紧邻的两张图」：中间没有空行（或被 OCR 丢掉）时它们的行间距与
   * 图内行间距一样小，纯几何会把两张图并成一块。而「这一行是另一张图的声明」是文本层的事，
   * 不由本模块判断，故做成注入的判据，调用方按自己的域给出。
   */
  stopAt?: (observation: PlacedObservation, index: number) => boolean
}

export const DEFAULT_GAP_FACTOR = 1.5

interface Range {
  left: number
  right: number
  top: number
  bottom: number
}

function isUsableBox(box: Rect): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height) &&
    box.width > 0 &&
    box.height > 0
  )
}

/** 观察的中点是否落在上界内。用中点而非整盒包含：贴边的观察有抖动，整盒判定会把合法的边界行也剔掉。 */
function centerWithin(box: Rect, bound: Rect | undefined): boolean {
  if (bound === undefined) {
    return true
  }
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  return (
    cx >= bound.x &&
    cx <= bound.x + bound.width &&
    cy >= bound.y &&
    cy <= bound.y + bound.height
  )
}

function rangeOf(observations: readonly PlacedObservation[], chosen: ReadonlySet<number>): Range {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const index of chosen) {
    const box = observations[index]?.box
    if (box === undefined) {
      continue
    }
    left = Math.min(left, box.x)
    right = Math.max(right, box.x + box.width)
    top = Math.min(top, box.y)
    bottom = Math.max(bottom, box.y + box.height)
  }
  return { left, right, top, bottom }
}

function medianHeight(observations: readonly PlacedObservation[], chosen: ReadonlySet<number>): number {
  const heights: number[] = []
  for (const index of chosen) {
    const box = observations[index]?.box
    if (box !== undefined) {
      heights.push(box.height)
    }
  }
  if (heights.length === 0) {
    return 0
  }
  heights.sort((a, b) => a - b)
  const middle = Math.floor(heights.length / 2)
  return heights.length % 2 === 1
    ? (heights[middle] as number)
    : ((heights[middle - 1] as number) + (heights[middle] as number)) / 2
}

/** 一个盒与当前区域在 x 方向的间隔；有重叠时为 0。 */
function horizontalGap(range: Range, box: Rect): number {
  return Math.max(0, Math.max(range.left, box.x) - Math.min(range.right, box.x + box.width))
}

/** 一个盒与当前区域在 y 方向的间隔；有重叠时为 0。 */
function verticalGap(range: Range, box: Rect): number {
  const boxBottom = box.y + box.height
  if (boxBottom <= range.top) {
    return range.top - boxBottom
  }
  if (box.y >= range.bottom) {
    return box.y - range.bottom
  }
  return 0
}

/**
 * 从 anchorIndex 出发按几何连续性扩张，返回并入的观察下标（升序）。nil 情形返回空数组。
 *
 * 扩张只在 `index >= anchorIndex` 的方向上进行——锚点是声明行，见文件头的方向性说明。
 */
function expandRegion(
  observations: readonly PlacedObservation[],
  anchorIndex: number,
  options: ChartRegionOptions,
): number[] {
  const gapFactor = options.gapFactor ?? DEFAULT_GAP_FACTOR
  const anchor = observations[anchorIndex]
  if (anchor === undefined || !isUsableBox(anchor.box) || !centerWithin(anchor.box, options.bound)) {
    return []
  }

  const chosen = new Set<number>([anchorIndex])
  // 锚点自己不计入边界扫描（它按定义就是这块图的首行）；扫到边界即停，边界那行及其以下属于下一块。
  let limit = observations.length
  for (let index = anchorIndex + 1; index < observations.length; index += 1) {
    const observation = observations[index]
    if (observation !== undefined && options.stopAt?.(observation, index) === true) {
      limit = index
      break
    }
  }

  for (;;) {
    const range = rangeOf(observations, chosen)
    const threshold = gapFactor * medianHeight(observations, chosen)
    let added = false
    for (let index = anchorIndex; index < limit; index += 1) {
      if (chosen.has(index)) {
        continue
      }
      const box = observations[index]?.box
      if (box === undefined || !isUsableBox(box) || !centerWithin(box, options.bound)) {
        continue
      }
      if (horizontalGap(range, box) > 0) {
        continue
      }
      if (verticalGap(range, box) >= threshold) {
        continue
      }
      chosen.add(index)
      added = true
    }
    if (!added) {
      break
    }
  }

  return [...chosen].sort((a, b) => a - b)
}

/**
 * 图在屏幕上占住的那几行观察（升序下标）。调用方据此同时得到「矩形」与「源码取哪几行」，
 * 两者出自同一次扩张，不会各判一次而错位。
 *
 * anchorIndex 是检测到图声明的那条观察在传入数组里的下标；调用方须保证二者同源（源文本按
 * 观察逐条以换行拼接，于是一条观察即一行，行号即下标）。anchor 缺失、退化或落在上界外时返回
 * 空数组——该图不覆盖，而不是拿整屏或选区矩形兜底。
 */
export function chartRegionMembers(
  observations: readonly PlacedObservation[],
  anchorIndex: number,
  options: ChartRegionOptions = {},
): number[] {
  return expandRegion(observations, anchorIndex, options)
}

/**
 * 给定观察下标，返回它们的并集矩形；下标为空或盒子全部退化时返回 null。
 *
 * 与 `chartRegionMembers` 配套使用，是「区域」的唯一出口：调用方拿到成员后既取这几行的源码、
 * 又算这块矩形，两者出自同一次扩张。不提供「只要矩形」的便捷函数，是免得两条路各算一遍而悄悄
 * 分叉（区域的边界规则一旦只加到其中一条，矩形与源码就会指不同的行）。
 */
export function rectOfMembers(
  observations: readonly PlacedObservation[],
  indices: readonly number[],
): Rect | null {
  if (indices.length === 0) {
    return null
  }
  const range = rangeOf(observations, new Set(indices))
  if (!Number.isFinite(range.left) || !Number.isFinite(range.top)) {
    return null
  }
  return {
    x: range.left,
    y: range.top,
    width: range.right - range.left,
    height: range.bottom - range.top,
  }
}
