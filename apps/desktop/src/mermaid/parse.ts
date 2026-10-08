import { installJsdomEnvironment } from './jsdom-env'
import type { MermaidValidator } from './index'

type MermaidApi = (typeof import('mermaid'))['default']

/**
 * mermaid 的真实语法校验：`mermaid.parse()` 通过即认为源码有效。
 *
 * Node 里 parse 可行但 render 不行（render 依赖真实 DOM/CSS API），这与「渲染放独立常驻网页」的设计
 * 天然吻合——本进程只做校验，不渲染。
 *
 * mermaid 是纯 ESM 且体量大，走运行时动态 import：一是避免被 rolldown 打进 CJS 主进程产物，
 * 二是让 jsdom 垫片能先于模块求值装好（见 jsdom-env.ts 的时机约束）。
 */
function loadCompiler(): Promise<MermaidApi> {
  installJsdomEnvironment()
  return import('mermaid').then((module) => {
    const mermaid = module.default
    // parse 只要最保守的配置；预置科技向样式属于 S7 渲染站的事，这里不掺和。
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    return mermaid
  })
}

/**
 * 生成一个 mermaid 校验器。首次调用会把 mermaid 与其 DOM 垫片加载起来（进程内一次），此后复用。
 * 校验失败（语法错、非图文本）一律返回 false，不区分错误类型——命中判定只需知道「能不能解析」。
 */
export function createMermaidValidator(): MermaidValidator {
  let compiler: Promise<MermaidApi> | null = null

  return async (source: string): Promise<boolean> => {
    try {
      const mermaid = await (compiler ??= loadCompiler())
      await mermaid.parse(source)
      return true
    } catch {
      return false
    }
  }
}
