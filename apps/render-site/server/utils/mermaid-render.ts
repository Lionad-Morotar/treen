import { JSDOM } from 'jsdom'
import { MERMAID_RENDER_CONFIG, stripMermaidInitDirectives } from '../../shared/mermaid-theme'
import { computeSvgBBox } from './svg-bbox'

/**
 * 服务端 mermaid 渲染：吃归一化前的源码，吐自带科技向样式的 SVG。
 *
 * mermaid 的 `render()` 在 Node 里可行，但**依赖两个垫片**，缺一即抛：
 * 1. `CSSStyleSheet` 需有 `cssRules`——mermaid 用它拼主题 CSS，jsdom 的 CSSStyleSheet 不带；
 * 2. `SVGElement.getBBox` 需有内容感知实现——mermaid 既用它量文字尺寸（决定节点大小），
 *    又用它算根 svg 的内容包围盒（决定 viewBox），jsdom 不实现 SVG 布局。
 * 二者分别由本文件的样式表垫片与 svg-bbox.ts 提供。浏览器有真实现，故只有服务端渲染需要这层。
 *
 * 产出物的几何依赖等宽字体度量（见 mermaid-theme 把字体钉成等宽），与本项目「图表样式由工具
 * 完全控制」一致：字体可控，度量才可控。
 */

type MermaidApi = (typeof import('mermaid'))['default']

/** 渲染结果：SVG 串与内容固有像素尺寸（与 IPC 契约的 `{ svg, width, height }` 对应）。 */
export interface MermaidRenderResult {
  svg: string
  width: number
  height: number
}

/**
 * 渲染失败。带 `statusCode`，Nitro 的错误序列化按属性读取，故无需引入 h3 的错误类
 * （Nitro 内嵌 h3 与直装版本会错位，见既有纪律）。
 */
export class MermaidRenderError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 422) {
    super(message)
    this.name = 'MermaidRenderError'
    this.statusCode = statusCode
  }
}

/** 垫片只装一次；重复装会覆盖已就绪的全局，反而打断首次渲染。 */
let domInstalled = false

/**
 * 装好 mermaid 在纯 Node 下需要的浏览器全局。调用时机是硬约束：必须在 mermaid（及其依赖
 * dompurify）被**求值**之前完成——dompurify 的导出形态取决于求值那刻有没有 window。
 *
 * 副作用是进程级的，也是本站**关闭 SSR**（见 nuxt.config 的 `ssr: false`）的直接原因：这些全局
 * 会把同进程里所有靠 `typeof window` 分支的库都当成浏览器，而 vue-router 的 `isBrowser` 恰好在
 * 模块求值期就固化成常量——于是「先渲染过、再访问页面」时 SSR 会走到裸 `history` 抛 ReferenceError。
 * 只跑客户端渲染就没有这段模块求值，污染无从发作。若日后要重开 SSR，必须先把渲染挪进 worker 线程。
 */
function installMermaidDomEnvironment(): void {
  if (domInstalled) {
    return
  }
  domInstalled = true

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true })
  const { window } = dom

  class RenderStylesheet {
    cssRules: Array<{ cssText: string }> = []

    replaceSync(text: string): void {
      this.cssRules = text
        .split('}')
        .filter((chunk) => chunk.trim() !== '')
        .map((chunk) => ({ cssText: `${chunk}}` }))
    }

    insertRule(rule: string, index: number = this.cssRules.length): number {
      this.cssRules.splice(index, 0, { cssText: rule })
      return index
    }

    deleteRule(index: number): void {
      this.cssRules.splice(index, 1)
    }
  }

  ;(window as unknown as { CSSStyleSheet: unknown }).CSSStyleSheet = RenderStylesheet
  ;(globalThis as unknown as { CSSStyleSheet: unknown }).CSSStyleSheet = RenderStylesheet

  const prototype = window.SVGElement.prototype as unknown as {
    getBBox: () => { x: number; y: number; width: number; height: number }
    getScreenCTM: () => object
    getComputedTextLength: () => number
  }
  prototype.getBBox = function (this: Element) {
    return computeSvgBBox(this) ?? { x: 0, y: 0, width: 0, height: 0 }
  }
  prototype.getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
  prototype.getComputedTextLength = function (this: Element) {
    return computeSvgBBox(this)?.width ?? 0
  }

  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    SVGElement: window.SVGElement,
    Element: window.Element,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    HTMLCanvasElement: window.HTMLCanvasElement,
    XMLSerializer: window.XMLSerializer,
    MutationObserver: window.MutationObserver,
    DOMParser: window.DOMParser,
    getComputedStyle: window.getComputedStyle.bind(window),
  }
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
}

/**
 * mermaid 实例挂在 globalThis 上而非模块级常量：Nitro dev 的 HMR 会用新模块实例重载 server 代码，
 * 模块级常量在重载后是全新的，而 globalThis 上的实例跨重载存活，避免每次改动都重装一次大依赖。
 */
const MERMAID_API_KEY = '__treen_render_site_mermaid__'

async function loadMermaid(): Promise<MermaidApi> {
  const store = globalThis as unknown as Record<string, unknown>
  const cached = store[MERMAID_API_KEY]
  if (cached !== undefined) {
    return cached as MermaidApi
  }
  installMermaidDomEnvironment()
  const module = await import('mermaid')
  const mermaid = module.default
  mermaid.initialize(MERMAID_RENDER_CONFIG as unknown as Parameters<MermaidApi['initialize']>[0])
  store[MERMAID_API_KEY] = mermaid
  return mermaid
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return String(error)
}

/** 从渲染出的 SVG 串读内容固有尺寸：优先 width/height 数值属性，退回 viewBox。 */
function readIntrinsicSize(svg: string): { width: number; height: number } {
  const width = numericAttr(svg, 'width')
  const height = numericAttr(svg, 'height')
  if (width !== null && height !== null) {
    return { width, height }
  }
  const viewBox = /viewBox="([^"]+)"/.exec(svg)
  if (viewBox !== null) {
    const parts = (viewBox[1] ?? '').trim().split(/[\s,]+/).map(Number)
    const w = parts[2]
    const h = parts[3]
    if (Number.isFinite(w) && Number.isFinite(h)) {
      return { width: w ?? 0, height: h ?? 0 }
    }
  }
  return { width: 0, height: 0 }
}

function numericAttr(svg: string, name: string): number | null {
  const match = new RegExp(String.raw`<svg[^>]*\s${name}="([^"]+)"`).exec(svg)
  if (match === null) return null
  const value = Number.parseFloat(match[1] ?? '')
  return Number.isFinite(value) ? value : null
}

let renderSequence = 0

/**
 * 渲染一段 mermaid 源码为 SVG。源码在渲染前再剥一次 `%%{init}%%`——即使调用方（归一化阶段）
 * 已剥过，渲染站也独立再剥（两侧同构的纵深防御：源码是不可信输入）。
 *
 * 语法非法时抛 `MermaidRenderError`（默认 422），不返回半成品。
 */
export async function renderMermaidSvg(source: string): Promise<MermaidRenderResult> {
  if (source.trim() === '') {
    throw new MermaidRenderError('mermaid 源码为空', 400)
  }
  const mermaid = await loadMermaid()
  const clean = stripMermaidInitDirectives(source)
  const id = `treen-mermaid-${(renderSequence += 1)}`

  let svg: string
  try {
    const rendered = await mermaid.render(id, clean)
    svg = rendered.svg
  } catch (error) {
    throw new MermaidRenderError(`mermaid 渲染失败：${messageOf(error)}`)
  }

  return { svg, ...readIntrinsicSize(svg) }
}
