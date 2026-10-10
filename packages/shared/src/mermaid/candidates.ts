import { detectMermaidBlocks } from './detect'
import { normalizeMermaid } from './normalize'

/**
 * 检测 + 归一化（不含校验）后的候选块。单独成模块而非并入桶文件，是为了让「只做检测与归一化」
 * 的调用方不连带拉起 `parse.ts`——它在 import 期即加载 jsdom 与 mermaid，那是校验专用的重依赖。
 */
export interface MermaidCandidateBlock {
  /** 归一化后的源码（剥围栏、全角括号归一、箭头修复、init 剥离），是渲染站要消费的形态 */
  source: string
  /** 检测到的原始候选文本（未归一化），留作排障与回放 */
  original: string
  /** 候选块起始行在原文中的行号（0 基，含声明行） */
  startLine: number
  /** 候选块结束行在原文中的行号（0 基，含端点） */
  endLine: number
}

/**
 * 从文本里抽出全部候选块并归一化，但**不**用 mermaid 校验。
 *
 * 与 `extractMermaidBlocks` 的分工：那个函数把「命中」定义为 mermaid 校验通过；本函数只做
 * 结构检测与归一化，把「是否有效图」留给调用方裁决——校验器未必是 mermaid 本身（覆盖渲染链路
 * 的校验器是渲染站，POST 渲染成功即有效），这类调用方不该被拖去加载一份 mermaid。
 */
export function normalizeMermaidCandidates(text: string): MermaidCandidateBlock[] {
  return detectMermaidBlocks(text).map((candidate) => ({
    source: normalizeMermaid(candidate.source),
    original: candidate.source,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
  }))
}
