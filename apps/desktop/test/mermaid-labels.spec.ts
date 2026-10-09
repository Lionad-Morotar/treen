import { describe, expect, it } from 'vitest'
import { collectNodeLabels, mapNodeLabels } from '../src/mermaid/labels'

/** 提取节点 id 的口技：与实现同构的「标识符 + 括号」扫描，仅供断言用。 */
function collectIds(source: string): string[] {
  const ids: string[] = []
  for (const line of source.split('\n')) {
    const pattern = /(^|[^A-Za-z0-9_])([A-Za-z0-9_]+)\s*[[( {]/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(line)) !== null) {
      ids.push(match[2] ?? '')
    }
  }
  return ids
}

describe('collectNodeLabels · 提取', () => {
  it('认四种主标签括号形态', () => {
    expect(collectNodeLabels('A[甲] --> B(乙)\nC{丙} --> D((丁))')).toEqual(['甲', '乙', '丙', '丁'])
  })

  it('重复标签只收一次，保持首次出现序', () => {
    expect(collectNodeLabels('A[同] --> B[同]\nC[异]')).toEqual(['同', '异'])
  })

  it('边标签不是节点标签', () => {
    expect(collectNodeLabels('A -->|边标| B')).toEqual([])
  })

  it('引号形态剥引号收文本', () => {
    expect(collectNodeLabels('A["甲(乙)"] --> B')).toEqual(['甲(乙)'])
  })

  it('注释行不参与收集', () => {
    expect(collectNodeLabels('%% A[这是注释]\nA[真的] --> B')).toEqual(['真的'])
  })

  it('未收窄的括号变体不命中：平行四边形与双花', () => {
    expect(collectNodeLabels('A[/斜的/] --> B{{六角}}')).toEqual([])
  })

  it('纯连线与声明行无标签', () => {
    expect(collectNodeLabels('graph LR\n  A --> B')).toEqual([])
  })

  it('括号不配对时不命中，不吞掉半个标签', () => {
    expect(collectNodeLabels('A[残缺 --> B')).toEqual([])
  })
})

describe('mapNodeLabels · 替换', () => {
  const to = (map: Record<string, string>) => (label: string) => map[label] ?? null

  it('只动标签文字，节点 id 集合不变', () => {
    const source = 'A[甲] --> B(乙)\nC{丙} --> D((丁))'
    const result = mapNodeLabels(source, to({ 甲: '甲译', 乙: '乙译', 丙: '丙译', 丁: '丁译' }))

    expect(result.output).toBe('A[甲译] --> B(乙译)\nC{丙译} --> D((丁译))')
    expect(collectIds(result.output)).toEqual(collectIds(source))
    expect(collectIds(result.output)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('visit 返回 null 的标签原样保留', () => {
    const result = mapNodeLabels('A[甲] --> B[乙]', to({ 甲: '甲译' }))

    expect(result.output).toBe('A[甲译] --> B[乙]')
  })

  it('同一标签的多处出现全部替换', () => {
    const result = mapNodeLabels('A[同] --> B[同]', to({ 同: '译文' }))

    expect(result.output).toBe('A[译文] --> B[译文]')
  })

  it('译文含括号等结构字符时强制引号包裹', () => {
    const result = mapNodeLabels('A[甲]', to({ 甲: '乙(丙)' }))

    expect(result.output).toBe('A["乙(丙)"]')
  })

  it('译文含引号时引号包裹并转义为 #quot;', () => {
    const result = mapNodeLabels('A[甲]', to({ 甲: '说"你好"' }))

    expect(result.output).toBe('A["说#quot;你好#quot;"]')
  })

  it('译文换行折成空格', () => {
    const result = mapNodeLabels('A[甲]', to({ 甲: '一行\n二行' }))

    expect(result.output).toBe('A[一行 二行]')
  })

  it('原文引号形态写回时保持引号', () => {
    const result = mapNodeLabels('A["甲(乙)"] --> B', to({ '甲(乙)': '甲译(乙译)' }))

    expect(result.output).toBe('A["甲译(乙译)"] --> B')
  })

  it('连线与边标签之间的普通文本不受影响', () => {
    const source = 'graph LR\n  A[甲] -->|边标| B(乙)'
    const result = mapNodeLabels(source, to({ 甲: '甲译', 乙: '乙译', 边标: '不该出现' }))

    expect(result.output).toBe('graph LR\n  A[甲译] -->|边标| B(乙译)')
    expect(result.output).toContain('|边标|')
  })

  it('collect 与 replace 对同一段源码认得同一批标签（无收集/替换漂移）', () => {
    const source = 'A[甲] --> B("乙(丙)")\nC{丁} --> D((戊))'
    const expected = collectNodeLabels(source)
    const result = mapNodeLabels(source, to(Object.fromEntries(expected.map((label) => [label, `${label}译`]))))

    expect(result.labels).toEqual(expected)
    for (const label of expected) {
      expect(result.output).toContain(`${label}译`)
    }
  })
})
