/**
 * jsdom 的最小本地类型声明。
 *
 * 刻意不引 @types/jsdom：它的入口声明带 `/// <reference lib="dom" />`，只要桌面主进程的程序里出现
 * 这个模块，lib.dom 就会被整体拖进来，全局 Blob/BlobPart 随之从 Node 版换成 DOM 版，反倒让主进程里
 * 本来成立的 `new Blob([buffer])` 变成类型错。桌面主进程是纯 Node、没有真 DOM，lib 保持 ES2023 才诚实，
 * 故只在本模块就地声明用得到的那一小片 jsdom 面（建 DOM + 取 window）。
 */
declare module 'jsdom' {
  export interface JsdomWindow {
    document: unknown
    navigator: unknown
    SVGElement: unknown
    Element: unknown
    Node: unknown
    HTMLElement: unknown
    HTMLCanvasElement: unknown
    XMLSerializer: unknown
    MutationObserver: unknown
    getComputedStyle: (element: unknown) => unknown
  }

  export class JSDOM {
    constructor(html?: string, options?: { pretendToBeVisual?: boolean })
    readonly window: JsdomWindow
  }
}
