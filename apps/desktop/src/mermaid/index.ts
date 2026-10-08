import { detectMermaidBlocks } from './detect'
import { normalizeMermaid } from './normalize'

export * from './detect'
export * from './normalize'
export { createMermaidValidator } from './parse'

/**
 * mermaid 语法校验端口：吃归一化后的源码，返回它能否被 mermaid 解析。
 * 抽成端口是为了让检测/归一化/命中的编排可被纯 Node 单测覆盖，真实现在 parse.ts 里惰性加载 mermaid。
 */
export type MermaidValidator = (source: string) => Promise<boolean>

/** 判定为「命中」的一段 mermaid。source 已归一化，是 S7 渲染站要消费的形态。 */
export interface MermaidBlock {
  /** 归一化后的源码，可直接送渲染 */
  source: string
  /** 检测到的原始候选文本（未归一化），留作排障与回放 */
  original: string
  startLine: number
  endLine: number
}

export interface ExtractMermaidOptions {
  validate: MermaidValidator
}

/**
 * 从一段文本里抽出全部「命中的 mermaid 块」。
 *
 * 三段式：检测挑候选（结构判定，跑在归一化前）→ 归一化修正 OCR 劣化（含样式锁定的 init 剥离）→
 * 用 mermaid.parse 裁决最终命中。只有 parse 通过的才算命中——检测与归一化都只是降低候选的不确定性，
 * 真正「这是不是一张能渲染的图」由 mermaid 自己说了算。
 */
export async function extractMermaidBlocks(text: string, options: ExtractMermaidOptions): Promise<MermaidBlock[]> {
  const hits: MermaidBlock[] = []

  for (const candidate of detectMermaidBlocks(text)) {
    const source = normalizeMermaid(candidate.source)
    if (await options.validate(source)) {
      hits.push({
        source,
        original: candidate.source,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
      })
    }
  }

  return hits
}
