import { describe, expect, it } from 'vitest'
import {
  detectMermaidBlocks,
  hasArrow,
  hasStructuralLine,
  isDiagramDeclaration,
  looksLikeStatementLine,
} from '../src/mermaid/detect'
import {
  BUG_OCR_SAMPLE,
  PROSE_MENTIONING_GRAPH,
  SCREENSHOT_OCR_ROI,
  SCREENSHOT_SOURCE,
} from './mermaid-fixtures'

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

  it('只收录结构判据能命中的图类型：无连线类型不入表，不留假支持', () => {
    expect(isDiagramDeclaration('classDiagram')).toBe(true)
    expect(isDiagramDeclaration('erDiagram')).toBe(true)
    expect(isDiagramDeclaration('stateDiagram-v2')).toBe(true)
    // 这些类型靠任务行/冒号项/缩进表达结构，箭头与关系算子都命中不了，入表即假支持。
    expect(isDiagramDeclaration('gantt')).toBe(false)
    expect(isDiagramDeclaration('pie')).toBe(false)
    expect(isDiagramDeclaration('mindmap')).toBe(false)
    expect(isDiagramDeclaration('gitGraph')).toBe(false)
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

describe('hasStructuralLine', () => {
  it('classDiagram / erDiagram 的关系算子也算结构行', () => {
    expect(hasStructuralLine('  Animal <|-- Duck')).toBe(true)
    expect(hasStructuralLine('  Animal ..|> Flyer')).toBe(true)
    expect(hasStructuralLine('  CUSTOMER ||--o{ ORDER : places')).toBe(true)
    expect(hasStructuralLine('  PERSON }o--|| COMPANY : works')).toBe(true)
  })

  it('纯自然语言行与孤立连字符不算结构行', () => {
    expect(hasStructuralLine('这句话没有任何连线')).toBe(false)
    expect(hasStructuralLine('A -- B')).toBe(false)
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

  it('classDiagram / erDiagram 靠关系算子检出，不依赖箭头', () => {
    expect(detectMermaidBlocks('classDiagram\n  Animal <|-- Duck')).toHaveLength(1)
    expect(detectMermaidBlocks('erDiagram\n  CUSTOMER ||--o{ ORDER : places')).toHaveLength(1)
  })

  it('无连线图类型当前不产出候选（类型专属句式判据尚未实现）', () => {
    expect(detectMermaidBlocks('gantt\ntitle 排期\nsection 一期\n设计 :a1, 2026-01-01, 10d')).toEqual([])
  })
})

describe('looksLikeStatementLine', () => {
  it('标识符起头且带箭头或括号标签的行像语句', () => {
    expect(looksLikeStatementLine('WAV --> B1［beat_this 神经拍追踪］')).toBe(true)
    expect(looksLikeStatementLine('WAV[track_full.wav] -→> A[famta beats]')).toBe(true)
    expect(looksLikeStatementLine('  Animal <|-- Duck')).toBe(true)
    expect(looksLikeStatementLine('CUSTOMER ||--o{ ORDER : places')).toBe(true)
    expect(looksLikeStatementLine('B1[beat_this 神经拍追踪]')).toBe(true)
    expect(looksLikeStatementLine('A(圆角标签)')).toBe(true)
  })

  it('中文正文长句不像语句（无标识符起头）', () => {
    expect(looksLikeStatementLine('作为参照系分段加对照，三方拍表出现分歧')).toBe(false)
    expect(looksLikeStatementLine('comb 模板 graph 在给定区间以 0.02 BPM 步进扫')).toBe(false)
  })

  it('行首标识符但既无箭头也无括号标签的行不像语句', () => {
    expect(looksLikeStatementLine('WAV 是音频文件')).toBe(false)
  })

  it('箭头变形又混入中文正文的垃圾行不像语句', () => {
    expect(looksLikeStatementLine('A—-2作为参照系分段+对照|C［三方拍表分歧 beats_multi］')).toBe(false)
  })

  it('纯数字或标点起头的行不像语句', () => {
    expect(looksLikeStatementLine('0.02 BPM 步进扫 --> 结果')).toBe(false)
    expect(looksLikeStatementLine('——这是一段引用')).toBe(false)
  })
})

describe('detectMermaidBlocks 无声明行判据（S14）', () => {
  it('真机缺陷样本：声明行丢失仍检出候选', () => {
    const blocks = detectMermaidBlocks(BUG_OCR_SAMPLE)

    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(blocks[0]?.source).toContain('WAV --> B1')
    // 几何锚点取段内首个语句行（段首的正文行不是图的最上行），样本段首即语句行。
    expect(blocks[0]?.startLine).toBe(0)
  })

  it('段首混入正文行时候选锚点取首个语句行', () => {
    const text = ['这是图上方的正文。', '正文占了两行。', 'WAV --> B1', 'WAV --> B2'].join('\n')
    const blocks = detectMermaidBlocks(text)

    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.startLine).toBe(2)
    expect(blocks[0]?.source).toContain('这是图上方的正文。')
  })

  it('段内至少两行像语句才检出：单行语句不成候选', () => {
    expect(detectMermaidBlocks('WAV --> B1')).toEqual([])
  })

  it('中文正文连续多行不产出候选（误收正文当图渲染比漏收更糟）', () => {
    const prose = [
      '作为参照系分段加对照，三方拍表出现分歧。',
      '波形对齐之后，各家的拍点首尾一致。',
      '差异集中在弱拍的位置上，需要人工复核。',
    ].join('\n')
    expect(detectMermaidBlocks(prose)).toEqual([])
  })

  it('正文提到 graph 的既有反例在无声明判据下同样不产出候选', () => {
    expect(detectMermaidBlocks(PROSE_MENTIONING_GRAPH)).toEqual([])
  })

  it('声明行判据优先：有声明时行为不变', () => {
    const blocks = detectMermaidBlocks('graph LR\n  A --> B')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.startLine).toBe(0)
  })

  it('空行分隔的无声明段与声明段分别检出', () => {
    const text = 'A --> B\nC --> D\n\nclassDiagram\n  Animal <|-- Duck'
    const blocks = detectMermaidBlocks(text)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.source).toBe('A --> B\nC --> D')
    expect(blocks[1]?.source).toBe('classDiagram\n  Animal <|-- Duck')
  })

  it('段内语句行不足两行、混正文为主时不产出候选', () => {
    const mixed = ['这张图说的是数据流。', 'WAV --> B1', '后面整段都是解释性文字，没有更多的连线或节点标签出现在这里。'].join('\n')
    expect(detectMermaidBlocks(mixed)).toEqual([])
  })
})
