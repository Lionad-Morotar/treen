import { describe, expect, it } from 'vitest'
import { detectMermaidBlocks, hasArrow, isDiagramDeclaration } from '../src/mermaid/detect'
import { PROSE_MENTIONING_GRAPH, SCREENSHOT_OCR_ROI, SCREENSHOT_SOURCE } from './mermaid-fixtures'

describe('isDiagramDeclaration', () => {
  it('接受行首图声明，容忍方向缩写与关键字之间的空格缺失', () => {
    expect(isDiagramDeclaration('graph LR')).toBe(true)
    expect(isDiagramDeclaration('graphLR')).toBe(true)
    expect(isDiagramDeclaration('flowchartTD')).toBe(true)
    expect(isDiagramDeclaration('  flowchart RL')).toBe(true)
    expect(isDiagramDeclaration('sequenceDiagram')).toBe(true)
    expect(isDiagramDeclaration('sequencediagram')).toBe(true)
  })

  it('拒绝以图关键字为前缀、但并非声明的普通行', () => {
    expect(isDiagramDeclaration('graphical display')).toBe(false)
    expect(isDiagramDeclaration('graph 是图论里的概念')).toBe(false)
    expect(isDiagramDeclaration('comb 模板 graph 在给定区间步进扫')).toBe(false)
    expect(isDiagramDeclaration('def graph(n):')).toBe(false)
  })

  it('拒绝裸 mermaid 标识行（fence 标识不作声明）', () => {
    expect(isDiagramDeclaration('mermaid')).toBe(false)
  })
})

describe('hasArrow', () => {
  it('识别规范箭头', () => {
    expect(hasArrow('  A --> B')).toBe(true)
    expect(hasArrow('A -->|标签| C')).toBe(true)
    expect(hasArrow('Alice ->> Bob')).toBe(true)
    expect(hasArrow('A -.-> B')).toBe(true)
    expect(hasArrow('A ==> B')).toBe(true)
  })

  it('识别 OCR 劣化后的箭头形态', () => {
    expect(hasArrow('A --》 B')).toBe(true)
    expect(hasArrow('A 一> B')).toBe(true)
    expect(hasArrow('A → B')).toBe(true)
    expect(hasArrow('A 》 B')).toBe(true)
  })

  it('不含箭头的行不误判', () => {
    expect(hasArrow('graph LR')).toBe(false)
    expect(hasArrow('comb 模板 graph 步进扫')).toBe(false)
    expect(hasArrow('A -- B')).toBe(false)
  })
})

describe('detectMermaidBlocks', () => {
  it('从真截图源文本里检出唯一候选块', () => {
    const blocks = detectMermaidBlocks(SCREENSHOT_SOURCE)

    expect(blocks).toHaveLength(1)
    // 候选块从声明行起，不含其前的围栏标识行。
    expect(blocks[0]?.source.startsWith('graph LR')).toBe(true)
    expect(blocks[0]?.source).toContain('WAV[track_full.wav] --> A[')
  })

  it('从 OCR 劣化源文本里同样检出候选块', () => {
    const blocks = detectMermaidBlocks(SCREENSHOT_OCR_ROI)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.source.startsWith('graph LR')).toBe(true)
  })

  it('正文提到 graph 不产出候选', () => {
    expect(detectMermaidBlocks(PROSE_MENTIONING_GRAPH)).toEqual([])
  })

  it('无空格粘连的 graphLR 仍被检出', () => {
    const blocks = detectMermaidBlocks('graphLR\n  A --> B')

    expect(blocks).toHaveLength(1)
  })

  it('声明行之后没有箭头行则不产出候选', () => {
    expect(detectMermaidBlocks('graph 是图论里的概念\n这句话没有任何连线')).toEqual([])
  })

  it('裸 mermaid 标识行加箭头行不产出候选', () => {
    expect(detectMermaidBlocks('mermaid\nWAV --> A')).toEqual([])
  })

  it('空行终止块边界，箭头行之后紧邻正文则并入候选（交由下游 parse 裁决）', () => {
    const text = 'graph LR\n  A --> B\n这段是紧邻正文没有空行'
    const blocks = detectMermaidBlocks(text)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.source).toContain('这段是紧邻正文没有空行')
  })

  it('空行分隔的多块分别检出', () => {
    const text = 'graph LR\n  A --> B\n\nsequenceDiagram\n  X ->> Y'

    const blocks = detectMermaidBlocks(text)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.source).toBe('graph LR\n  A --> B')
    expect(blocks[1]?.source).toBe('sequenceDiagram\n  X ->> Y')
  })

  it('行号覆盖声明行到块尾', () => {
    const blocks = detectMermaidBlocks('前置正文\n\ngraph LR\n  A --> B')

    expect(blocks[0]).toMatchObject({ startLine: 2, endLine: 3 })
  })
})
