import type { Size } from './overlay/layout'

/**
 * 渲染站产物契约：mermaid 源码进，SVG 与内容固有尺寸出。
 *
 * 单点定义在这里而非各端各写一份：桌面壳的客户端按它解析响应，装配层按它算版位，
 * 渲染站的服务端路由后续也复用同一份形状——两侧各写一份会在改字段时静默分叉。
 */

/** 渲染成功的结果：SVG 串 + 内容固有像素尺寸（供 contain 适配）。 */
export interface MermaidRenderResult {
  svg: string
  intrinsic: Size
}
