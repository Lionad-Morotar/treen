import { describe, expect, it, vi } from 'vitest'
import { buildRefineBody, createMermaidRefiner, parseRefineResponse, REFINE_MAX_SOURCE_CHARS } from '../src/mermaid/refine'

describe('buildRefineBody：修复请求体形态', () => {
  it('关掉思考、走 JSON 模式，且 prompt 显式要求 JSON（官方文档：只设 response_format 不指示会吐空白）', () => {
    const body = buildRefineBody('flowchart TD\nA-->B') as {
      model: string
      thinking: { type: string }
      response_format: { type: string }
      temperature: number
      messages: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe('deepseek-flash')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
    // 修复比翻译更讲确定性：低于批量翻译的 0.2（非思考模式的唯一旋钮）
    expect(body.temperature).toBeLessThan(0.2)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]?.content).toContain('JSON')
    expect(body.messages[1]?.content).toContain('flowchart TD')
  })

  it('system 指令划出修复范围：语法符号修复与垃圾行剔除，声明行必须保留', () => {
    const body = buildRefineBody('x') as { messages: Array<{ content: string }> }
    const system = body.messages[0]?.content ?? ''
    expect(system).toContain('声明')
    expect(system).toContain('mermaid')
  })
})

describe('parseRefineResponse：返回解析与回退', () => {
  it('对象形态 {"source": ...} 直接取用，并再过一遍归一化（剥围栏与 init 的安全网）', () => {
    const parsed = parseRefineResponse('{"source": "flowchart TD\\nA-->B\\n%%{init:{}}%%\\nC-->D"}')
    expect(parsed).not.toBeNull()
    expect(parsed).toContain('flowchart TD')
    expect(parsed).not.toContain('%%{init')
  })

  it('模型漂移出裸字符串 JSON 时也接受', () => {
    expect(parseRefineResponse('"flowchart TD\\nA-->B"')).toBe('flowchart TD\nA-->B')
  })

  it('完全不是 JSON、但带代码围栏的文本：取出围栏内的源码', () => {
    const parsed = parseRefineResponse('```mermaid\nflowchart LR\nA-->B\n```')
    expect(parsed).toContain('flowchart LR')
  })

  it('解析不出源码、归一后为空、或没有声明行，一律拒绝（返回 null 由调用方落回兜底）', () => {
    expect(parseRefineResponse('not json at all')).toBeNull()
    expect(parseRefineResponse('{"source": ""}')).toBeNull()
    expect(parseRefineResponse('{"source": "A-->B"}')).toBeNull()
  })
})

describe('parseRefineResponse · 超长护栏', () => {
  it('候选超过长度上限即拒绝：宁可不采纳，也不让重写当修复', () => {
    const huge = `flowchart TD\nA-->B\n${'x'.repeat(REFINE_MAX_SOURCE_CHARS)}`
    expect(parseRefineResponse(JSON.stringify({ source: huge }))).toBeNull()
  })
})

describe('createMermaidRefiner：注入出口的修复动作', () => {
  it('返回可用源码时给出归一后的修复版，出口恰调一次且吃的正是修复请求体', async () => {
    const complete = vi.fn<(body: unknown) => Promise<string>>(async () => '{"source": "flowchart TD\\nA-->B"}')
    const refine = createMermaidRefiner({ complete })
    const out = await refine('flowchart TD\nA-->1')
    expect(out).toBe('flowchart TD\nA-->B')
    expect(complete).toHaveBeenCalledTimes(1)
    const body = complete.mock.calls[0]?.[0] as { messages: Array<{ content: string }> }
    expect(body.messages[1]?.content).toContain('A-->1')
  })

  it('出口抛错原样上抛：降级与否由调用方决定，这里不吞错也不静默回退原文', async () => {
    const refine = createMermaidRefiner({
      complete: async () => {
        throw new Error('网络断了')
      },
    })
    await expect(refine('flowchart TD\nA-->B')).rejects.toThrow('网络断了')
  })

  it('返回不可用时抛错而不是返回 null：必经步骤的失败必须显式可捕获', async () => {
    const refine = createMermaidRefiner({ complete: async () => '胡说八道' })
    await expect(refine('flowchart TD\nA-->B')).rejects.toThrow(/修复|不可用|无法/)
  })
})
