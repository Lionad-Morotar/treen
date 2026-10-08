import { describe, expect, it } from 'vitest'
import {
  MERMAID_RENDER_CONFIG,
  MERMAID_THEME_VARIABLES,
  stripMermaidInitDirectives,
} from '../shared/mermaid-theme'

describe('mermaid 样式锁定', () => {
  it('锁死在 base 主题 + strict 安全级 + 深色科技向变量', () => {
    expect(MERMAID_RENDER_CONFIG.theme).toBe('base')
    expect(MERMAID_RENDER_CONFIG.securityLevel).toBe('strict')
    expect(MERMAID_RENDER_CONFIG.startOnLoad).toBe(false)
    expect(MERMAID_THEME_VARIABLES.darkMode).toBe(true)
    expect(MERMAID_RENDER_CONFIG.secure).toContain('securityLevel')
  })

  it('关闭 useMaxWidth 以取内容固有尺寸', () => {
    expect(MERMAID_RENDER_CONFIG.flowchart.useMaxWidth).toBe(false)
    expect(MERMAID_RENDER_CONFIG.sequence.useMaxWidth).toBe(false)
  })

  it('stripMermaidInitDirectives 吃掉指令且保留行结构', () => {
    const stripped = stripMermaidInitDirectives('a\n%%{init: {"a": 1}}%%\nb')
    expect(stripped).not.toContain('init')
    expect(stripped.split('\n')).toHaveLength(3)
  })
})
