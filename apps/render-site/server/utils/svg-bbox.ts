import { advanceEm } from '@treen/shared/text-metrics'

/**
 * 纯 Node 的 SVG 包围盒计算：给 jsdom 里的 `getBBox()` 提供一个内容感知的实现。
 *
 * 为什么必须有这层：mermaid 的最终 `viewBox` 取自根 `<svg>` 的 `getBBox()`（见 mermaid 的
 * setupViewPortForSVG），而 jsdom 不实现 SVG 布局、`getBBox()` 恒抛或返回零值。若不补，
 * 产出物的 viewBox 与画面不符（内容被裁或缩成一点），SVG 实际不可用。所以这里按 DOM 结构递归
 * 求各元素的几何包围盒并做并集，是服务端渲染能产出**正确**产物的前提，不是可选优化。
 *
 * 覆盖 mermaid 实际会产出的元素（rect/circle/ellipse/line/polygon/path/text/foreignObject/image）
 * 与 `transform`（translate/scale/matrix/rotate）。`path` 的曲线控制点按坐标点取包围盒，
 * 是略保守的上界（曲线在控制点凸包内），对 mermaid 的边与圆角形状足够。
 *
 * 文本按**等宽字体**度量：Treen 把图表字体钉成等宽（见 mermaid-theme），等宽字体的字宽是常量，
 * 故文本宽度 = Σ(逐字符 em) × fontSize。前进宽度表与覆盖层共用一处（`@treen/shared/text-metrics`），
 * 因为两者绑的是同一个字体栈，分开维护会在换字体时静默分叉。
 */

export interface SvgBox {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 文本纵向包围盒相对基线的缩放（em）。取自真机 Chromium 实测：等宽字体栈下基线以上
 * 15px、以下 4px，font-size 16 时合计 19px——即浏览器 `getBBox()` 对 `<text>` 返回的是
 * **字体度量盒**（ascent+descent），而非字形墨迹的紧包围盒，故高度与文本内容无关（`a` 与 `ag` 同为 19），
 * 只随 font-size 缩放。用这组常量才能与浏览器同形。
 */
const ASCENT_EM = 15 / 16
const DESCENT_EM = 4 / 16

/** 矩阵 `[a, b, c, d, e, f]`，与 SVG `matrix()` 同序。 */
type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** 非渲染容器：其子树不参与包围盒。 */
const NON_RENDERED_TAGS = new Set([
  'defs',
  'marker',
  'clippath',
  'mask',
  'pattern',
  'lineargradient',
  'radialgradient',
  'filter',
  'style',
  'title',
  'desc',
  'metadata',
  'symbol',
])

const NUM = String.raw`-?\d*\.?\d+(?:e[-+]?\d+)?`

/** 解析 `transform` 属性为矩阵。无法识别的片段按恒等跳过（宁少算不抛）。 */
export function parseSvgTransform(transform: string | null | undefined): Matrix {
  if (transform === null || transform === undefined || transform.trim() === '') {
    return IDENTITY
  }
  let result = IDENTITY
  const re = new RegExp(String.raw`(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(transform)) !== null) {
    const name = match[1]
    const args = (match[2] ?? '')
      .split(/[\s,]+/)
      .filter((s) => s !== '')
      .map(Number)
      .filter((n) => Number.isFinite(n))
    result = multiplyMatrix(result, transformOf(name, args))
  }
  return result
}

function transformOf(name: string | undefined, a: readonly number[]): Matrix {
  const [x = 0, y = 0] = a
  switch (name) {
    case 'translate':
      return [1, 0, 0, 1, x, y]
    case 'scale': {
      const sx = a[0] ?? 1
      const sy = a[1] ?? sx
      return [sx, 0, 0, sy, 0, 0]
    }
    case 'rotate': {
      const rad = (x * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const baseline: Matrix = [cos, sin, -sin, cos, 0, 0]
      if (a.length >= 3) {
        // rotate(angle cx cy)：绕 (cx,cy) 旋转 = 平移到原点 → 旋转 → 平移回。
        const cx = a[1] ?? 0
        const cy = a[2] ?? 0
        return multiplyMatrix(multiplyMatrix([1, 0, 0, 1, cx, cy], baseline), [1, 0, 0, 1, -cx, -cy])
      }
      return baseline
    }
    case 'skewX':
      return [1, 0, Math.tan((x * Math.PI) / 180), 1, 0, 0]
    case 'skewY':
      return [1, Math.tan((x * Math.PI) / 180), 0, 1, 0, 0]
    case 'matrix':
      return [a[0] ?? 1, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1, a[4] ?? 0, a[5] ?? 0]
    default:
      return IDENTITY
  }
}

function multiplyMatrix(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

function applyMatrix(m: Matrix, box: SvgBox): SvgBox {
  const xs: number[] = []
  const ys: number[] = []
  for (const [px, py] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ] as const) {
    xs.push(m[0] * px + m[2] * py + m[4])
    ys.push(m[1] * px + m[3] * py + m[5])
  }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

function unionBox(a: SvgBox | null, b: SvgBox | null): SvgBox | null {
  if (a === null) return b
  if (b === null) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x, y, width: right - x, height: bottom - y }
}

function attr(el: Element, name: string): number {
  const raw = el.getAttribute(name)
  if (raw === null) return Number.NaN
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : Number.NaN
}

function or0(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/** 元素在不含自身 transform 时的局部包围盒；返回 null 表示该元素不直接占据几何。 */
function localBox(el: Element): SvgBox | null {
  const box = rawLocalBox(el)
  // 零面积元素不计入：mermaid 常用无尺寸的占位 <rect>（量到真尺寸前），把它当 0×0 参与并集
  // 会凭空扩大父级包围盒（标签组因此偏高）。真零面积的图形（空 line 等）本就无几何贡献。
  return box !== null && box.width === 0 && box.height === 0 ? null : box
}

function rawLocalBox(el: Element): SvgBox | null {
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'rect':
    case 'foreignobject':
    case 'image':
    case 'use':
      return { x: or0(attr(el, 'x')), y: or0(attr(el, 'y')), width: or0(attr(el, 'width')), height: or0(attr(el, 'height')) }
    case 'circle': {
      const r = or0(attr(el, 'r'))
      return { x: or0(attr(el, 'cx')) - r, y: or0(attr(el, 'cy')) - r, width: 2 * r, height: 2 * r }
    }
    case 'ellipse': {
      const rx = or0(attr(el, 'rx'))
      const ry = or0(attr(el, 'ry'))
      return { x: or0(attr(el, 'cx')) - rx, y: or0(attr(el, 'cy')) - ry, width: 2 * rx, height: 2 * ry }
    }
    case 'line': {
      const x1 = or0(attr(el, 'x1'))
      const y1 = or0(attr(el, 'y1'))
      const x2 = or0(attr(el, 'x2'))
      const y2 = or0(attr(el, 'y2'))
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
    }
    case 'polygon':
    case 'polyline':
      return pointsBox(el.getAttribute('points'))
    case 'path':
      return numbersBox(el.getAttribute('d'))
    case 'text':
    case 'tspan':
      return textBox(el)
    default:
      return null
  }
}

function pointsBox(points: string | null): SvgBox | null {
  if (points === null) return null
  const nums = (points.match(new RegExp(NUM, 'g')) ?? []).map(Number)
  if (nums.length < 2) return null
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    xs.push(nums[i] ?? 0)
    ys.push(nums[i + 1] ?? 0)
  }
  return boxOfCoords(xs, ys)
}

/**
 * 路径按坐标点取包围盒：成对读取 `d` 里的数字。曲线控制点落在曲线凸包外缘、
 * 圆弧参数（`A` 命令的 rx/ry/角度）会被误当坐标，故这是保守上界；对 mermaid 的边足够。
 */
function numbersBox(d: string | null): SvgBox | null {
  if (d === null) return null
  const nums = (d.match(new RegExp(NUM, 'g')) ?? []).map(Number)
  if (nums.length < 2) return null
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) {
    xs.push(nums[i] ?? 0)
    ys.push(nums[i + 1] ?? 0)
  }
  return boxOfCoords(xs, ys)
}

function boxOfCoords(xs: readonly number[], ys: readonly number[]): SvgBox {
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

/**
 * 解析文本锚点。属性优先，其次内联样式；都没有时**默认取 `middle`**。
 *
 * 默认 middle 而非 SVG 规范的 start，是因为 mermaid 的标签居中靠的是 SVG 内部 `<style>` 里的
 * `text-anchor: middle` 规则（如 `.nodeLabel`），而 jsdom 不解析 SVG 内部样式表，属性与内联样式都读不到——
 * 若按 start 处理，居中的标签会被当成从 x 起排，节点包围盒凭空多出半个标签宽（实测节点组 bbox
 * 由 224.6 被撑到 305，dagre 据以排布，图整体被拉开 ~30%）。统一按 mermaid 的实际行为居中。
 */
function resolveTextAnchor(el: Element): string {
  const attrValue = el.getAttribute('text-anchor')
  if (attrValue !== null) return attrValue
  const style = el.getAttribute('style') ?? ''
  const inline = /(?:^|;)\s*text-anchor\s*:\s*([a-z]+)/.exec(style)?.[1]
  return inline ?? 'middle'
}

/** 带单位的长度值转用户单位：`1.1em` 按 font-size 换算，`-10.1`/`8px` 原样取值。 */
function resolveLength(raw: string, fontSize: number): number {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return 0
  return raw.trim().endsWith('em') ? value * fontSize : value
}

/**
 * 求 `<text>` 各行基线 y。关键：`<text y>` **不生效**——mermaid 把定位放在子 `<tspan y dy>` 上
 * （如 `<text y="-10.1"><tspan y="-0.1em" dy="1.1em">`，真实基线 = (-0.1 + 1.1)em = 1em = 16px，
 * 与浏览器实测吻合），而 SVG 规范里 tspan 的 `y` 是绝对坐标、`dy` 在其上叠加，父元素 `y` 被覆盖。
 * 只读 `<text y>` 会把标签盒整体抬高约 26px，节点包围盒随之多出 ~14px，最终 viewBox 被撑高 24%。
 *
 * 逐 tspan 累积得到每一行的基线（嵌套 tspan 无 y/dy 时基线不变），交由调用方取并集，
 * 以便多行文本（换行）时纵向盒覆盖全部行。当前样式已关闭换行，实际只有一行。
 */
function textBaselines(el: Element, fontSize: number): number[] {
  const tspans = Array.from(el.querySelectorAll('tspan'))
  if (tspans.length === 0) {
    return [or0(attr(el, 'y'))]
  }
  const baselines: number[] = []
  let y = or0(attr(el, 'y'))
  for (const tspan of tspans) {
    const yAttr = tspan.getAttribute('y')
    if (yAttr !== null) y = resolveLength(yAttr, fontSize)
    const dyAttr = tspan.getAttribute('dy')
    if (dyAttr !== null) y += resolveLength(dyAttr, fontSize)
    baselines.push(y)
  }
  return baselines
}

/** 等宽字体下的文本包围盒。x 由文本锚点定，纵向由基线 ± 字体度量盒定。 */
function textBox(el: Element): SvgBox | null {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const fontSize = fontSizeOf(el)
  if (text === '') {
    return null
  }
  const anchor = resolveTextAnchor(el)
  const rawX = or0(attr(el, 'x'))
  const width = advanceEm(text) * fontSize
  // middle/end 锚点让文本以 x 为中心/右端对齐；只影响 x 落点，不影响尺寸。
  const x = anchor === 'middle' ? rawX - width / 2 : anchor === 'end' ? rawX - width : rawX
  const ascent = ASCENT_EM * fontSize
  const descent = DESCENT_EM * fontSize
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const baseline of textBaselines(el, fontSize)) {
    top = Math.min(top, baseline - ascent)
    bottom = Math.max(bottom, baseline + descent)
  }
  return { x, y: top, width, height: bottom - top }
}

function fontSizeOf(el: Element): number {
  const style = (el as SVGElement & { style?: CSSStyleDeclaration }).style
  const styled = style?.fontSize
  if (styled !== undefined && styled !== '' && styled.endsWith('px')) {
    const value = Number.parseFloat(styled)
    if (Number.isFinite(value) && value > 0) return value
  }
  const own = attr(el, 'font-size')
  if (Number.isFinite(own) && own > 0) return own
  const parent = el.parentElement
  return parent === null ? 16 : fontSizeOf(parent)
}

function elementBox(el: Element, inherited: Matrix): SvgBox | null {
  const tag = el.tagName.toLowerCase()
  if (NON_RENDERED_TAGS.has(tag)) {
    return null
  }
  const ctm = multiplyMatrix(inherited, parseSvgTransform(el.getAttribute('transform')))

  // <text> 只按自身 textContent 计一次盒，不再并入 tspan：tspan 是同一段文字的换行/定位副本，
  // 逐个并入会把行高累加成两倍（实测 19 → 29），节点因此偏高。
  if (tag === 'text') {
    const local = localBox(el)
    return local === null ? null : applyMatrix(ctm, local)
  }

  let acc: SvgBox | null = null
  for (const child of Array.from(el.children)) {
    acc = unionBox(acc, elementBox(child, ctm))
  }
  if (el.children.length === 0) {
    const local = localBox(el)
    if (local !== null) {
      acc = unionBox(acc, applyMatrix(ctm, local))
    }
  }
  return acc
}

/** 计算一个 SVG 根元素的内容包围盒（含 transform 累积）。空内容返回 null。 */
export function computeSvgBBox(root: Element): SvgBox | null {
  return elementBox(root, IDENTITY)
}
