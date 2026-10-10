import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectMermaidBlocks } from '../src/mermaid/detect'
import { createMermaidValidator, extractMermaidBlocks, normalizeMermaid } from '../src/mermaid'
import { chartSourceCandidates } from '../src/overlay/compose'
import { SCREENSHOT_OCR_ROI, SCREENSHOT_SOURCE } from './mermaid-fixtures'

/** S14 真机缺陷样本：OCR 完全没认出声明行的 flowchart（含垃圾行与各类箭头劣化）。 */
const BUG_OCR_SAMPLE = readFileSync(join(import.meta.dirname, 'fixtures/ocr-graph-missing-declaration.txt'), 'utf8')

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

  it('S14 真机缺陷样本（声明行丢失）：检测出候选，装配补声明后至少一条通过 parse', async () => {
    // 用户实测缺陷的验收口径：OCR 认丢了 `graph LR` 行，此前候选数为 0、源码被当正文译一遍。
    // 断言不依赖渲染站在跑：装配层（补默认声明 + 归一）的产物由 parse 直接裁决。
    const candidates = detectMermaidBlocks(BUG_OCR_SAMPLE)
    expect(candidates.length).toBeGreaterThanOrEqual(1)

    const sources = chartSourceCandidates(candidates[0]!.source.split('\n')).map((attempt) => attempt.source)
    expect(sources.length).toBeGreaterThanOrEqual(1)
    expect(await Promise.all(sources.map((source) => validate(source)))).toContain(true)
  })
})
