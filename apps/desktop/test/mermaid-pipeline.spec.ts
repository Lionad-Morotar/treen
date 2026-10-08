import { describe, expect, it, vi } from 'vitest'
import { extractMermaidBlocks } from '../src/mermaid'
import { SCREENSHOT_OCR_ROI } from './mermaid-fixtures'

describe('extractMermaidBlocks', () => {
  it('只保留校验通过的候选，并返回归一化后的源码', async () => {
    const validate = vi.fn(async () => true)

    const hits = await extractMermaidBlocks('graph LR\n  A --》 B', { validate })

    expect(validate).toHaveBeenCalledTimes(1)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.source).toBe('graph LR\n  A --> B')
    expect(hits[0]?.original).toBe('graph LR\n  A --》 B')
  })

  it('交给校验器的是归一化后的源码', async () => {
    const seen: string[] = []

    await extractMermaidBlocks('graph LR\n  A --》 B\n  C［x］', {
      validate: async (source) => {
        seen.push(source)
        return true
      },
    })

    expect(seen[0]).toContain('-->')
    expect(seen[0]).toContain('[x]')
    expect(seen[0]).not.toContain('［')
  })

  it('校验失败的候选被排除，不算命中', async () => {
    expect(await extractMermaidBlocks('graph LR\n  A --> B', { validate: async () => false })).toEqual([])
  })

  it('多候选按各自校验结果取舍', async () => {
    const text = 'graph LR\n  A --> B\n\nflowchart TD\n  X --> Y'

    const hits = await extractMermaidBlocks(text, { validate: async (source) => source.startsWith('graph') })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.source.startsWith('graph LR')).toBe(true)
  })

  it('没有可检测候选时返回空数组', async () => {
    expect(await extractMermaidBlocks('一段普通正文，不含任何图', { validate: async () => true })).toEqual([])
  })

  it('对真机 ROI-OCR 文本，检测+归一化产出候选且把干净源码交给校验器', async () => {
    const seen: string[] = []

    await extractMermaidBlocks(SCREENSHOT_OCR_ROI, {
      validate: async (source) => {
        seen.push(source)
        return true
      },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('graph LR')
    expect(seen[0]).not.toContain('［')
    expect(seen[0]?.split('\n').every((line) => line.trim() !== 'mermaid')).toBe(true)
  })
})
