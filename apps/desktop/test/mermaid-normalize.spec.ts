import { describe, expect, it } from 'vitest'
import { normalizeMermaid } from '../src/mermaid/normalize'
import { SCREENSHOT_OCR_ROI, SCREENSHOT_SOURCE } from './mermaid-fixtures'

describe('normalizeMermaid · 剥围栏', () => {
  it('剥掉 ```mermaid 围栏行', () => {
    const out = normalizeMermaid('```mermaid\nflowchart LR\n  A --> B\n```')

    expect(out).not.toContain('```')
    expect(out).toContain('flowchart LR')
    expect(out).toContain('  A --> B')
  })

  it('剥掉丢失反引号的裸 mermaid 标识行', () => {
    const out = normalizeMermaid('mermaid\ngraph LR\nA --> B')

    expect(out.split('\n').every((line) => line.trim() !== 'mermaid')).toBe(true)
    expect(out).toContain('graph LR')
  })
})

describe('normalizeMermaid · 全角括号归一', () => {
  it('全角方括号与竖线归一到半角', () => {
    const out = normalizeMermaid('graph LR\n  A［x］ --> B【y】\n  C｜label｜')

    expect(out).toContain('A[x] --> B[y]')
    expect(out).toContain('C|label|')
  })
})

describe('normalizeMermaid · 箭头归一（单次扫描）', () => {
  it.each([
    ['A --》 B', 'A --> B'],
    ['A 一> B', 'A --> B'],
    ['A → B', 'A --> B'],
    ['A 》 B', 'A --> B'],
    ['A ---> B', 'A --> B'],
    ['A ——> B', 'A --> B'],
    ['A ——》 B', 'A --> B'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeMermaid(input)).toBe(expected)
  })

  it('已是规范箭头的输入不被二次替换（单次扫描不变量）', () => {
    expect(normalizeMermaid('A --> B')).toBe('A --> B')
    expect(normalizeMermaid('A -->|作为参照系分段+对照| C')).toBe('A -->|作为参照系分段+对照| C')
  })

  it('保留 sequenceDiagram 的 ->> 语义，不压成 -->', () => {
    expect(normalizeMermaid('Alice ->> Bob: 你好')).toBe('Alice ->> Bob: 你好')
    expect(normalizeMermaid('Bob -->> Alice: 收到')).toBe('Bob -->> Alice: 收到')
  })

  it('保留 -- 连线与 -.-> 虚线箭头语义', () => {
    expect(normalizeMermaid('A -- B')).toBe('A -- B')
    expect(normalizeMermaid('A -.-> B')).toBe('A -.-> B')
    expect(normalizeMermaid('A --o B')).toBe('A --o B')
  })

  it('虚线箭头的笔画之间被 OCR 塞进空格时也还原', () => {
    expect(normalizeMermaid('A -. -> B')).toBe('A -.-> B')
    expect(normalizeMermaid('A - . -> B')).toBe('A -.-> B')
    expect(normalizeMermaid('A - . - B')).toBe('A -.- B')
  })
})

describe('normalizeMermaid · 图声明规范化', () => {
  it('补回关键字与方向之间丢失的空格', () => {
    expect(normalizeMermaid('graphLR\n  A --> B')).toBe('graph LR\n  A --> B')
    expect(normalizeMermaid('flowchartTD\n  A --> B')).toBe('flowchart TD\n  A --> B')
  })

  it('归一图类型关键字大小写', () => {
    expect(normalizeMermaid('sequencediagram\n  X ->> Y')).toBe('sequenceDiagram\n  X ->> Y')
    expect(normalizeMermaid('statediagram-v2\n  A --> B')).toBe('stateDiagram-v2\n  A --> B')
    expect(normalizeMermaid('classdiagram\n  Animal <|-- Duck')).toBe('classDiagram\n  Animal <|-- Duck')
    expect(normalizeMermaid('erdiagram\n  A ||--o{ B : x')).toBe('erDiagram\n  A ||--o{ B : x')
  })
})

describe('normalizeMermaid · init 指令剥离（样式锁定执行点）', () => {
  it('剥离单行 init 指令，不留给 mermaid 消费', () => {
    const out = normalizeMermaid('%%{init: {"themeVariables": {"primaryColor": "#ff0000"}}}%%\nflowchart LR\n  A --> B')

    expect(out).not.toContain('%%{')
    expect(out).not.toContain('themeVariables')
    expect(out).toContain('flowchart LR')
  })

  it('剥离跨行且花括号嵌套的 init 指令', () => {
    const out = normalizeMermaid('%%{init: {\n  "theme": "base",\n  "themeVariables": { "primaryColor": "#0f0" }\n} }%%\nflowchart LR\n  A --> B')

    expect(out).not.toContain('%%{')
    expect(out).not.toContain('themeVariables')
    expect(out).toContain('flowchart LR')
  })

  it('普通 %% 注释不被误当 init 指令', () => {
    expect(normalizeMermaid('flowchart LR\n  %% 这是注释\n  A --> B')).toContain('%% 这是注释')
  })

  it('独占整行的 init 指令剥离后不留多余空行', () => {
    expect(normalizeMermaid('%%{init: {"a": 1}}%%\nflowchart LR\n  A --> B')).toBe('flowchart LR\n  A --> B')
    expect(normalizeMermaid('flowchart LR\n%%{init: {"a": 1}}%%\n  A --> B')).toBe('flowchart LR\n  A --> B')
  })

  it('跨行 init 指令剥离后同样不留多余空行', () => {
    expect(normalizeMermaid('%%{init: {\n  "theme": "base"\n} }%%\nflowchart LR')).toBe('flowchart LR')
  })
})

describe('normalizeMermaid · 真样本与幂等', () => {
  it('归一整段真机 ROI-OCR 文本：围栏与全角括号清除，箭头保留', () => {
    const out = normalizeMermaid(SCREENSHOT_OCR_ROI)

    expect(out).not.toContain('［')
    expect(out).not.toContain('］')
    expect(out.split('\n').every((line) => line.trim() !== 'mermaid')).toBe(true)
    expect(out).toContain('graph LR')
    expect(out).toContain('WAV --> B2')
    expect(out).toContain('A -->|作为参照系分段＋对照| C')
  })

  it('对真截图源文本幂等：再归一一次不改变结果', () => {
    const once = normalizeMermaid(SCREENSHOT_SOURCE)
    const twice = normalizeMermaid(once)

    expect(twice).toBe(once)
  })
})

describe('normalizeMermaid · 劣化箭头的裸 > 收窄（S14）', () => {
  it('-→> 归一为 --> 且吃掉紧邻裸 >（flowchart 不接受 -->>）', () => {
    expect(normalizeMermaid('WAV -→> A')).toBe('WAV --> A')
    expect(normalizeMermaid('A —》 B')).toBe('A --> B')
    expect(normalizeMermaid('A -〉> B')).toBe('A --> B')
  })

  it('纯 ASCII 的 ->> 与 -->> 完整保留（sequenceDiagram 语义不误伤）', () => {
    expect(normalizeMermaid('Alice ->> Bob: hi')).toBe('Alice ->> Bob: hi')
    expect(normalizeMermaid('Alice -->> Bob: hi')).toBe('Alice -->> Bob: hi')
  })

  it('全角箭头后紧跟多个裸 > 也只产出一条规范箭头', () => {
    expect(normalizeMermaid('A -→>> B')).toBe('A --> B')
  })

  it('全角箭头后不是裸 > 的场景不受影响', () => {
    expect(normalizeMermaid('A → B')).toBe('A --> B')
    expect(normalizeMermaid('A →|标签| B')).toBe('A -->|标签| B')
  })
})

describe('normalizeMermaid · <br/> 劣化形态归一（S14）', () => {
  it('sbr/>、br/> 归一为 <br/>', () => {
    expect(normalizeMermaid('A[beats_multisbr/>compare.py]')).toBe('A[beats_multi<br/>compare.py]')
    expect(normalizeMermaid('A[beats_multi br/>compare.py]')).toBe('A[beats_multi <br/>compare.py]')
    expect(normalizeMermaid('A[beats_multibr/>compare.py]')).toBe('A[beats_multi<br/>compare.py]')
  })

  it('完整 <br/> 不动，全角尾 <br/› 归一为 <br/>', () => {
    expect(normalizeMermaid('A[beats<br/>times]')).toBe('A[beats<br/>times]')
    expect(normalizeMermaid('A[beats<br/›times]')).toBe('A[beats<br/>times]')
  })

  it('缺尾的 <br 补全为 <br/>，非 br 的 < 开头序列不动', () => {
    expect(normalizeMermaid('A[beats<br]')).toBe('A[beats<br/>]')
    expect(normalizeMermaid('A[beats<br times]')).toBe('A[beats<br/> times]')
    // <br> 与 <br > 是 mermaid 最常见的多行标签写法，归一后不得多出字面 >。
    expect(normalizeMermaid('A[foo<br>bar]')).toBe('A[foo<br/>bar]')
    expect(normalizeMermaid('A[beats<br >times]')).toBe('A[beats<br/>times]')
    // <br 后跟字母区分不了 <break 与粘连劣化，保守保留原样。
    expect(normalizeMermaid('A[较小 <box> 形态]')).toBe('A[较小 <box> 形态]')
    expect(normalizeMermaid('A[<break 点>]')).toBe('A[<break 点>]')
  })

  it('sequenceDiagram 声明在场时全角箭头劣化形保留 ->> 语义', () => {
    // 声明行给出图类型上下文：sequence 的 -->> 合法，-》> 劣化形不应被压成实线 -->。
    expect(normalizeMermaid('sequenceDiagram\nAlice -》> Bob: hi')).toBe('sequenceDiagram\nAlice -->> Bob: hi')
    expect(normalizeMermaid('sequenceDiagram\nAlice -→> Bob: hi')).toBe('sequenceDiagram\nAlice -->> Bob: hi')
    // flowchart 声明在场（或声明丢失）时照旧收窄：-->> 会被 parse 拒。
    expect(normalizeMermaid('graph LR\nA -→> B')).toBe('graph LR\nA --> B')
    expect(normalizeMermaid('A -→> B')).toBe('A --> B')
  })

  it('真机缺陷样本归一后首行可解析、垃圾行劣化被修', () => {
    const sample = [
      'WAV[track_full.wav] -→> A[famta beats<br/>beat_times_full.json]',
      'WAV --> B1［beat_this 神经拍追踪］',
      'A—-2作为参照系分段+对照|C［三方拍表分歧 beats_multisbr/>compare_anchors.Py］',
    ].join('\n')
    const out = normalizeMermaid(sample)

    expect(out.split('\n')[0]).toBe('WAV[track_full.wav] --> A[famta beats<br/>beat_times_full.json]')
    expect(out.split('\n')[2]).toContain('<br/>compare_anchors.Py')
  })
})
