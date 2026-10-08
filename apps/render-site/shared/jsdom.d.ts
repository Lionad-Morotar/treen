/**
 * jsdom 的最小本地类型声明（只声明服务端渲染实际用到的面）。
 *
 * 刻意不引 `@types/jsdom`：其入口带 `/// <reference lib="dom" />`，会把整套 DOM lib 拖进
 * server 程序，让「服务端不该有真 DOM」这件事在类型层面失真。服务端只需要「建 DOM、取 window、
 * 在 window 上挂 CSSStyleSheet 与 SVG 垫片」，就地声明这一小片即可。
 *
 * 放 shared/ 而非 server/ 是因为 Nuxt 生成的 app 与 server 两个 tsconfig program 都 include
 * `shared/**`，放这里才能被两侧同时看见；放 server/ 只被 server program 覆盖，编辑器解析会报缺声明。
 */
declare module 'jsdom' {
  export interface JsdomWindow {
    document: unknown
    navigator: unknown
    SVGElement: { prototype: object }
    Element: unknown
    Node: unknown
    HTMLElement: unknown
    HTMLCanvasElement: unknown
    XMLSerializer: unknown
    MutationObserver: unknown
    DOMParser: unknown
    getComputedStyle: (element: unknown) => unknown
  }

  export class JSDOM {
    constructor(html?: string, options?: { pretendToBeVisual?: boolean })
    readonly window: JsdomWindow
  }
}
