import { describe, expect, it } from 'vitest'
import type { MermaidRenderResult } from '@treen/shared/render'
import type { TranslateCompleter } from '@treen/shared/translation'
import { runPipeline } from '../server/utils/dev-pipeline'
import { IMAGE, recognize } from './pipeline-fixtures'

/** 翻译替身：记下每次收到的文本，按 `译：<原文>` 作答。 */
function recordingCompleter(sent: string[][]): TranslateCompleter {
  return async (body) => {
    const messages: unknown[] = Array.isArray((body as { messages?: unknown }).messages)
      ? [...(body as { messages: unknown[] }).messages]
      : []
    const user = [...messages].reverse().find((entry) => (entry as { role?: unknown }).role === 'user')
    const content = (user as { content?: unknown } | undefined)?.content
    if (typeof content !== 'string') {
      throw new Error('请求体里没有 user content')
    }
    const marker = content.indexOf('{"texts"')
    const texts = (JSON.parse(content.slice(marker)) as { texts: string[] }).texts
    sent.push(texts)
    return JSON.stringify({ translations: texts.map((text) => `译:${text}`) })
  }
}

function svgResult(): MermaidRenderResult {
  return { svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }
}

describe('runPipeline', () => {
  it('一次跑完 OCR、翻译与图表装配，坐标落在图像像素上', async () => {
    const sent: string[][] = []
    const sources: string[] = []

    const result = await runPipeline(
      { image: IMAGE },
      {
        recognize,
        complete: recordingCompleter(sent),
        render: async (source) => {
          sources.push(source)
          return svgResult()
        },
      },
    )

    expect(result.blocks).toHaveLength(3)
    const first = result.blocks[0]
    expect(first).toBeDefined()
    if (first !== undefined) {
      expect(first.text).toBe('Title')
      expect(first.box.x).toBeCloseTo(0)
      expect(first.box.y).toBeCloseTo(0)
      expect(first.box.width).toBeCloseTo(60)
      expect(first.box.height).toBeCloseTo(20)
    }

    expect(result.translations).toEqual(['译:Title', '译:graph LR', '译:A --> B'])
    expect(sent.length).toBeGreaterThan(0)

    expect(sources.some((source) => source.includes('graph LR'))).toBe(true)
    expect(result.plan.charts).toHaveLength(1)
    expect(result.plan.charts[0]?.svg).toContain('<svg')
    // 图区域内的译文让位，区域外的正文照常覆盖。
    expect(result.plan.texts.map((text) => text.lines.join(''))).toEqual(['译:Title'])

    expect(result.timings.ocrMs).toBeGreaterThanOrEqual(0)
    expect(result.timings.translateMs).toBeGreaterThanOrEqual(0)
    expect(result.timings.chartMs).toBeGreaterThanOrEqual(0)
  })

  it('渲染被拒时图不出现，但译文照常覆盖并把原因收进 diagnostics', async () => {
    const sent: string[][] = []

    const result = await runPipeline(
      { image: IMAGE },
      {
        recognize,
        complete: recordingCompleter(sent),
        render: async () => {
          throw new Error('渲染站不可达')
        },
      },
    )

    expect(result.plan.charts).toHaveLength(0)
    expect(result.translations).toEqual(['译:Title', '译:graph LR', '译:A --> B'])
    // 图没出来，它占的那两行就不再让位——三行译文全部照常覆盖，而不是跟着图一起消失。
    expect(result.plan.texts.map((text) => text.lines.join(''))).toEqual([
      '译:Title',
      '译:graph LR',
      '译:A --> B',
    ])
    // 诊断留痕是这条端点的本职：调试页要能回答「为什么这张图没出来」。
    expect(result.diagnostics.some((entry) => entry.includes('mermaid 渲染失败'))).toBe(true)
  })

  it('关掉文本翻译时不发翻译请求，图照常渲染', async () => {
    const sent: string[][] = []

    const result = await runPipeline(
      { image: IMAGE, translateText: false },
      {
        recognize,
        complete: recordingCompleter(sent),
        render: async () => svgResult(),
      },
    )

    // 空串占位而非缺项：译文数组恒与 blocks 等长，调试页按索引对齐即可。
    expect(result.translations).toEqual(['', '', ''])
    expect(sent).toEqual([])
    expect(result.plan.texts).toHaveLength(0)
    expect(result.plan.charts).toHaveLength(1)
  })

  it('关掉图表翻译时既不渲染也不检测图', async () => {
    const sent: string[][] = []
    let renderCalls = 0

    const result = await runPipeline(
      { image: IMAGE, translateCharts: false },
      {
        recognize,
        complete: recordingCompleter(sent),
        render: async () => {
          renderCalls += 1
          return svgResult()
        },
      },
    )

    expect(renderCalls).toBe(0)
    expect(result.plan.charts).toHaveLength(0)
    expect(result.plan.texts.map((text) => text.lines.join(''))).toEqual([
      '译:Title',
      '译:graph LR',
      '译:A --> B',
    ])
  })
})

describe('runPipeline · LLM 修复接线', () => {
  /** 修复替身：记录收到的源码，按给定结果作答。 */
  function refinerStub(result: string | ((source: string) => string)) {
    const inputs: string[] = []
    const refine = async (source: string) => {
      inputs.push(source)
      return typeof result === 'string' ? result : result(source)
    }
    return { refine, inputs }
  }

  function recordingRender() {
    const sources: string[] = []
    const render = async (source: string) => {
      sources.push(source)
      return svgResult()
    }
    return { render, sources }
  }

  it('有图时逐图恰修一次、吃全区域归一版，修复前后对照与命中来源进 diagnostics', async () => {
    const sent: string[][] = []
    const { refine, inputs } = refinerStub('flowchart LR\nA --> B')
    const { render, sources } = recordingRender()

    const result = await runPipeline(
      { image: IMAGE },
      { recognize, complete: recordingCompleter(sent), render, refine },
    )

    expect(inputs).toEqual(['graph LR\nA --> B'])
    expect(sources[0]).toBe('flowchart LR\nA --> B')
    expect(result.diagnostics.some((entry) => entry.includes('LLM 修复输入'))).toBe(true)
    expect(result.diagnostics.some((entry) => entry.includes('LLM 修复输出'))).toBe(true)
    expect(result.diagnostics.some((entry) => entry.includes('命中来源为 LLM 修复版'))).toBe(true)
  })

  it('修复抛错时落回规则候选：尝试序列与无修复一致，原因与命中来源都进 diagnostics', async () => {
    const sent: string[][] = []
    const refine = async (): Promise<string> => {
      throw new Error('DeepSeek 请求失败')
    }
    const { render, sources } = recordingRender()

    const result = await runPipeline({ image: IMAGE }, { recognize, complete: recordingCompleter(sent), render, refine })

    expect(sources).toEqual(['graph LR\nA --> B'])
    expect(result.plan.charts).toHaveLength(1)
    expect(result.diagnostics.some((entry) => entry.includes('LLM 修复失败'))).toBe(true)
    expect(result.diagnostics.some((entry) => entry.includes('命中来源为规则候选'))).toBe(true)
  })

  it('超长修复输出的诊断条目被截短：留痕区不被极端吐长淹没，截断量照实标注', async () => {
    const sent: string[][] = []
    const huge = `flowchart TD\n${'x'.repeat(50_000)}`
    const { refine } = refinerStub(huge)
    const { render } = recordingRender()

    const result = await runPipeline({ image: IMAGE }, { recognize, complete: recordingCompleter(sent), render, refine })

    const entry = result.diagnostics.find((line) => line.includes('LLM 修复输出'))
    expect(entry).toBeDefined()
    expect(entry!.length).toBeLessThan(4500)
    expect(entry).toContain('截短')
  })

  it('图表开关关闭时不触发修复调用', async () => {
    const { refine, inputs } = refinerStub('flowchart LR\nA --> B')
    const result = await runPipeline(
      { image: IMAGE, translateCharts: false },
      { recognize, complete: recordingCompleter([]), refine },
    )
    expect(inputs).toHaveLength(0)
    expect(result.plan.charts).toHaveLength(0)
  })
})
