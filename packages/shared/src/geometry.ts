/**
 * 轴对齐几何基元：矩形与矩形交集。
 *
 * 矩形定在这里而不在壳层：shared 同时被渲染站的服务端消费，反向依赖桌面域会把 Electron 侧的形状
 * 拖进服务端；桌面壳把这份结构再导出，取字、布局、图表区域的调用方按结构兼容传入即可。
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
