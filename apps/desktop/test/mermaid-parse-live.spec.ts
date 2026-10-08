import { describe, expect, it } from 'vitest'
import { createMermaidValidator, extractMermaidBlocks, normalizeMermaid } from '../src/mermaid'
import { SCREENSHOT_OCR_ROI, SCREENSHOT_SOURCE } from './mermaid-fixtures'

/**
 * mermaid.parse 的真链路：真实 mermaid（12.x）+ jsdom 垫片在纯 Node 下跑通语法校验。
 *
 * 这是注入替身的单测盖不到的一段——DOM 垫片、dompurify 的模块求值时机、mermaid 的 ESM 加载，
 * 只有真加载一次才证明得了；本文件因此不做任何对 mermaid 的替身。
 */
describe('mermaid.parse 真链路（Node + jsdom 垫片）', () => {
  const validate = createMermaidValidator()

  it('合法 flowchart 与 sequenceDiagram 通过', async () => {
    expect(await validate('flowchart LR\n  A[开始] --> B{判断}\n  B -->|是| C[结束]')).toBe(true)
    expect(await validate('sequenceDiagram\n  Alice ->> Bob: 你好')).toBe(true)
  })

  it('语法错误的源码不通过', async () => {
    expect(await validate('flowchart LR\n  A[开始] --> B{判断')).toBe(false)
  })

  it('正文提到 graph 的普通文本不通过', async () => {
    expect(await validate('comb 模板 graph 在给定区间以 0.02 BPM 步进扫')).toBe(false)
  })

  it('parse 层不拦 init 指令——故样式锁定必须在归一化阶段自行剥离', async () => {
    const withInit = '%%{init: {"themeVariables": {"primaryColor": "#ff0000"}}}%%\nflowchart LR\n  A --> B'

    expect(await validate(withInit)).toBe(true)
    expect(normalizeMermaid(withInit)).not.toContain('%%{')
  })

  it('真截图源文本：检测 → 归一化 → parse 全链路命中', async () => {
    const hits = await extractMermaidBlocks(SCREENSHOT_SOURCE, { validate })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.source).toContain('graph LR')
  })

  it('真机 ROI-OCR 劣化文本：全链路仍命中', async () => {
    const hits = await extractMermaidBlocks(SCREENSHOT_OCR_ROI, { validate })

    expect(hits).toHaveLength(1)
  })
})
