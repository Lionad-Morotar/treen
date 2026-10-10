import { describe, expect, it } from 'vitest'
import type { MermaidRenderResult } from '@treen/shared/render'
import type { OcrEngine, TranslateCompleter } from '@treen/shared/translation'
import { runPipeline } from '../server/utils/dev-pipeline'

const SIZE = { width: 500, height: 300 }

/**
 * 一屏三行：正文 + 两行图源码。几何取自共享层装配单测里已被验证能检出一张图的那一屏，
 * 故这里的断言只关心「渲染站侧把它们拼起来了」，几何扩张本身的算法不重复校验。
 */
const LINES = [
  { text: 'Title', box: { x: 0, y: 0, width: 60, height: 20 } },
  { text: 'graph LR', box: { x: 200, y: 100, width: 80, height: 20 } },
  { text: 'A --> B', box: { x: 200, y: 125, width: 140, height: 20 } },
]

/** 造一个只有签名与 IHDR 的 PNG 头：装配只从字节里读尺寸，不作图。 */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

const IMAGE = `data:image/png;base64,${Buffer.from(pngHeader(SIZE.width, SIZE.height)).toString('base64')}`

/** 识别替身：按整幅图的归一化坐标交出三行观察，不碰二进制。 */
const recognize: OcrEngine = async () => ({
  observations: LINES.map((line) => ({
    text: line.text,
    confidence: 0.9,
    boundingBox: {
      x: line.box.x / SIZE.width,
      y: line.box.y / SIZE.height,
      width: line.box.width / SIZE.width,
      height: line.box.height / SIZE.height,
    },
  })),
})

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
