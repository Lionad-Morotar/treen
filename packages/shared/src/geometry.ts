/**
 * 轴对齐几何基元：矩形与矩形交集。
 *
 * 这里不沿用壳层 freeze/geometry 的同名类型：shared 同时被渲染站的服务端消费，反向依赖桌面域
 * 会把 Electron 侧的形状拖进服务端；而取字、布局、图表区域都只要这一个结构投影，调用方
 * （桌面帧、渲染站自有形状）按结构兼容传入即可。
 */

/** 轴对齐矩形：左上原点 + 尺寸，单位由上下文给定（DIP 或归一化）。 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 两个矩形的交集；无交集时宽或高为 0。 */
export function intersectRects(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}
