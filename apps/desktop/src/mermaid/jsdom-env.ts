import { JSDOM } from 'jsdom'

/**
 * 在纯 Node 里给 mermaid（及其依赖 dompurify）凑出它需要的浏览器全局。
 *
 * 调用时机是硬约束：必须在 dompurify / mermaid 模块被**求值**之前完成。dompurify 的默认导出形态取决于
 * 模块求值那一刻有没有 window——无 window 时它导出工厂函数，mermaid 随后对其调 `DOMPurify.addHook` 会
 * 直接 TypeError（现象是 flowchart 解析崩、sequence 却能过）。所以本函数要由解析适配器在 `import('mermaid')`
 * 之前显式调用，而不是靠模块副作用。
 *
 * 只在 Node 主进程与测试环境用；Electron 渲染进程有真 DOM，不走这条。
 */
let installed = false

export function installJsdomEnvironment(): void {
  if (installed) {
    return
  }
  installed = true

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true })
  const { window } = dom

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
    getComputedStyle: window.getComputedStyle.bind(window),
  }

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
}
