import { describe, expect, it } from 'vitest'
import { composeOverlayPlan, type OverlayBlock } from '../src/overlay/compose'

const REGION = { x: 0, y: 0, width: 500, height: 300 }

/** scene() 里两行图源码的几何并集：从声明行出发向下并入相连的一行。 */
const CHART_REGION = { x: 200, y: 100, width: 140, height: 45 }

/**
 * 一条正文 + 一块两行的图。正文排在候选之前，既验证「图块起于声明行」的锚定，
 * 也留出一段图区域外的译文供共存断言。
 */
function scene(): OverlayBlock[] {
  return [
    { source: '标题', translation: '标题', box: { x: 0, y: 0, width: 60, height: 20 } },
    { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
    { source: 'A --> B', translation: '甲到乙', box: { x: 200, y: 125, width: 140, height: 20 } },
  ]
}

/** 渲染替身：记下每次送渲染的源码，按给定 SVG 作答。 */
function renderStub(svg = '<svg viewBox="0 0 100 50"></svg>') {
  const sources: string[] = []
  const render = async (source: string) => {
    sources.push(source)
    return { svg, intrinsic: { width: 100, height: 50 } }
  }
  return { render, sources }
}

/** 渲染故障替身：同样记录尝试，然后抛出。 */
function failingRender(message = '渲染站不可达') {
  const sources: string[] = []
  const render = async (source: string): Promise<never> => {
    sources.push(source)
    throw new Error(message)
  }
  return { render, sources }
}

/** 模拟真实渲染站：源码里混进正文就报语法错，也就是实际会遇到的 Lexical error。 */
function strictRender() {
  const sources: string[] = []
  const render = async (source: string) => {
    sources.push(source)
    if (source.includes('正文')) {
      throw new Error('Lexical error on line 3. Unrecognized text.')
    }
    return { svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }
  }
  return { render, sources }
}

describe('composeOverlayPlan：译文与图的覆盖计划装配', () => {
  it('检出图块、按几何区域定位并渲染，得到一张图', async () => {
    const { render, sources } = renderStub()

    const plan = await composeOverlayPlan(scene(), REGION, { render })

    expect(sources).toHaveLength(1)
    expect(sources[0]).toContain('graph LR')
    expect(plan.charts).toHaveLength(1)
    // 图占的区域是两行图源码的并集；在这里只验「落在区域内且居中」，缩放的算式归 layout 单测管，
    // 断言具体像素等于把算式抄一遍。
    const chart = plan.charts[0]!
    expect(chart.x).toBeGreaterThanOrEqual(CHART_REGION.x)
    expect(chart.y).toBeGreaterThanOrEqual(CHART_REGION.y)
    expect(chart.x + chart.width).toBeLessThanOrEqual(CHART_REGION.x + CHART_REGION.width)
    expect(chart.y + chart.height).toBeLessThanOrEqual(CHART_REGION.y + CHART_REGION.height)
    expect(chart.x + chart.width / 2).toBeCloseTo(CHART_REGION.x + CHART_REGION.width / 2)
    expect(chart.svg).toContain('<svg')
  })

  it('图区域内的译文让位，区域外的译文照常覆盖', async () => {
    const { render } = renderStub()

    const plan = await composeOverlayPlan(scene(), REGION, { render })

    expect(plan.texts.map((text) => text.lines.join(''))).toEqual(['标题'])
  })

  it('渲染失败时该图跳过，译文照出——一块图消失不连累整片译文', async () => {
    const { render, sources } = failingRender()

    const plan = await composeOverlayPlan(scene(), REGION, { render })

    // 确实送到了渲染站，只是它失败了。
    expect(sources).toHaveLength(1)
    expect(plan.charts).toHaveLength(0)
    expect(plan.texts).toHaveLength(3)
  })

  it('图后紧跟正文时裁掉尾部非连线行重试，图仍落位且版位只算到连线行', async () => {
    const { render, sources } = strictRender()
    // 三行挨得很近（含紧跟的正文），几何上连成一片，源码裁剪无从下手——只能由渲染站裁决。
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'A --> B', translation: '甲到乙', box: { x: 200, y: 125, width: 140, height: 20 } },
      { source: '这一段紧跟图后的正文。', translation: 'Trailing prose.', box: { x: 200, y: 150, width: 200, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render })

    expect(sources).toHaveLength(2)
    expect(sources[0]).toContain('正文')
    expect(sources[1]).toBe('graph LR\nA --> B')
    // 版位收到连线行为止（y 100..145）：被裁掉的正文行不再被图盖住，它的译文照常覆盖。
    const chart = plan.charts[0]!
    expect(chart.y + chart.height).toBeLessThanOrEqual(145)
    expect(plan.texts.map((text) => text.lines.join(''))).toEqual(['Trailing prose.'])
  })

  it('上下紧贴的两张图不被并成一块：上一张只取自己的行', async () => {
    const { render, sources } = renderStub()
    // 两张图之间没有空行（或被 OCR 丢掉），行距与图内行距一样小，纯几何分不开。
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '图一声明', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'A --> B', translation: '甲到乙', box: { x: 200, y: 125, width: 140, height: 20 } },
      { source: 'graph TD', translation: '图二声明', box: { x: 200, y: 150, width: 80, height: 20 } },
      { source: 'C --> D', translation: '丙到丁', box: { x: 200, y: 175, width: 140, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render })

    // 若把两张图并成一块，源码含两个声明，渲染站必然语法错，两张图一起消失。
    expect(sources).toHaveLength(1)
    expect(sources[0]).toBe('graph LR\nA --> B')
    const chart = plan.charts[0]!
    expect(chart.y + chart.height).toBeLessThanOrEqual(145)
    // 第二张图的几行没被图的版位吃掉，其译文照常覆盖。
    expect(plan.texts.map((text) => text.lines.join(''))).toEqual(['图二声明', '丙到丁'])
  })

  it('连线行落在几何区域之外（只剩声明行）时不渲染，免得用空图盖住声明行', async () => {
    const { render, sources } = renderStub()
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '图声明', box: { x: 0, y: 0, width: 80, height: 20 } },
      { source: 'A --> B', translation: '甲到乙', box: { x: 0, y: 400, width: 140, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render })

    expect(sources).toHaveLength(0)
    expect(plan.charts).toHaveLength(0)
  })

  it('无图候选时只覆盖译文', async () => {
    const { render } = renderStub()
    const blocks: OverlayBlock[] = [
      { source: '普通正文', translation: '普通正文译', box: { x: 0, y: 0, width: 100, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render })

    expect(plan.charts).toHaveLength(0)
    expect(plan.texts).toHaveLength(1)
  })

  it('候选声明落在选区外时求不到区域，跳过该图且不调渲染站', async () => {
    const { render, sources } = renderStub()

    const plan = await composeOverlayPlan(scene(), { x: 0, y: 0, width: 100, height: 50 }, { render })

    expect(sources).toHaveLength(0)
    expect(plan.charts).toHaveLength(0)
  })

  it('不注入渲染方即不产图表，也不做 mermaid 检测（省掉整段无用功）', async () => {
    const plan = await composeOverlayPlan(scene(), REGION, {})

    expect(plan.charts).toHaveLength(0)
    // 图块让位逻辑随之消失，图区域的译文得以照常覆盖。
    expect(plan.texts).toHaveLength(scene().length)
  })

  it('关闭译文（texts:false）时只出图，不产出任何译文盒', async () => {
    const { render, sources } = renderStub()

    const plan = await composeOverlayPlan(scene(), REGION, { render, texts: false })

    expect(sources).toHaveLength(1)
    expect(plan.charts).toHaveLength(1)
    expect(plan.texts).toHaveLength(0)
  })
})
