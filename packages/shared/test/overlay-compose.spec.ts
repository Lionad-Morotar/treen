import { describe, expect, it, vi } from 'vitest'
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
    { source: 'Title', translation: '标题', box: { x: 0, y: 0, width: 60, height: 20 } },
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

/** 节点文案翻译替身：记录每次请求的标签，按词典作答。 */
function labelTranslator(map: Record<string, string>) {
  const requested: string[][] = []
  const translateLabels = async (labels: readonly string[]) => {
    requested.push([...labels])
    return labels.map((label) => map[label] ?? label)
  }
  return { translateLabels, requested }
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

  it('图后紧跟正文时全区域候选被拒，由裁剪候选兜底，版位只算到连线行', async () => {
    const { render, sources } = strictRender()
    // 三行挨得很近（含紧跟的正文），几何上连成一片。全区域候选先试（被正文行拖挂拒绝），
    // 砍尾候选与语句行过滤候选撞出同一行集只发一次，图仍出来。
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

  it('末行像语句但非连线行时靠砍尾候选重试成功', async () => {
    const { render, sources } = strictRender()
    // 末行形如「id[标签]」（像语句、无箭头），语句行过滤放它过、结构计数又不认它——
    // 首候选整段被渲染站拒后，仍由砍掉尾部残句的候选兜底，图不因一行残句消失。
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'A --> B', translation: '甲到乙', box: { x: 200, y: 125, width: 140, height: 20 } },
      { source: 'B1[图后紧跟的正文行]', translation: '残句行', box: { x: 200, y: 150, width: 200, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render })

    expect(sources).toHaveLength(2)
    expect(sources[0]).toContain('正文')
    expect(sources[1]).toBe('graph LR\nA --> B')
    const chart = plan.charts[0]!
    expect(chart.y + chart.height).toBeLessThanOrEqual(145)
    expect(plan.texts.map((text) => text.lines.join(''))).toEqual(['残句行'])
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

  it('译文与原文相同的块不产译文盒，有真实译文的块照常上屏', async () => {
    // 语言门控让中文条目以原文回填后，译文===原文的块若照常装配，OCR 出的同文会糊在原字上。
    const blocks: OverlayBlock[] = [
      { source: '标题', translation: '标题', box: { x: 0, y: 0, width: 60, height: 20 } },
      { source: 'Title', translation: '标题译', box: { x: 0, y: 40, width: 60, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, {})

    expect(plan.texts.map((text) => text.lines.join(''))).toEqual(['标题译'])
  })

  it('上屏门控不伤图表版位：中文屏上整屏译文被滤，图照常落位', async () => {
    const { render } = renderStub()
    const blocks: OverlayBlock[] = [
      { source: '开始', translation: '开始', box: { x: 0, y: 0, width: 60, height: 20 } },
      { source: 'graph LR', translation: 'graph LR', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'A --> B', translation: 'A --> B', box: { x: 200, y: 125, width: 140, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render })

    expect(plan.texts).toHaveLength(0)
    expect(plan.charts).toHaveLength(1)
    const chart = plan.charts[0]!
    expect(chart.x).toBeGreaterThanOrEqual(CHART_REGION.x)
    expect(chart.y).toBeGreaterThanOrEqual(CHART_REGION.y)
  })
})

describe('composeOverlayPlan · 图内节点文案翻译', () => {
  /** 一块带节点标签的图：两个方形标签，供替换断言。 */
  function labeledScene(): OverlayBlock[] {
    return [
      { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'A[流程甲] --> B[流程乙]', translation: '原文行', box: { x: 200, y: 125, width: 200, height: 20 } },
    ]
  }

  it('送渲染的是替换后源码，节点 id 不动，图照常落位', async () => {
    const { render, sources } = renderStub()
    const { translateLabels, requested } = labelTranslator({ 流程甲: 'Process A', 流程乙: 'Process B' })

    const plan = await composeOverlayPlan(labeledScene(), REGION, { render, translateLabels })

    expect(requested).toEqual([['流程甲', '流程乙']])
    expect(sources[0]).toBe('graph LR\nA[Process A] --> B[Process B]')
    expect(plan.charts).toHaveLength(1)
  })

  it('带出的是渲染成功的那份源码：译文版被接收时就是译文版，被拒则是兜底那份', async () => {
    // 消费方要拿这份源码重渲一遍才能比「为什么你渲得出我渲不出」，取错一份就变成自造差异。
    const { render, sources } = renderStub()
    const { translateLabels } = labelTranslator({ 流程甲: 'Process A', 流程乙: 'Process B' })

    const accepted = await composeOverlayPlan(labeledScene(), REGION, { render, translateLabels })
    expect(accepted.charts[0]?.source).toBe(sources[0])
    expect(accepted.charts[0]?.source).toContain('Process A')

    const sources2: string[] = []
    const rejectingRender = async (source: string) => {
      sources2.push(source)
      if (source.includes('Process')) {
        throw new Error('Lexical error')
      }
      return { svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }
    }

    const fallback = await composeOverlayPlan(labeledScene(), REGION, {
      render: rejectingRender,
      translateLabels,
    })
    expect(fallback.charts[0]?.source).toBe(sources2[sources2.length - 1])
    expect(fallback.charts[0]?.source).toContain('流程甲')
  })

  it('翻译抛错时图用原文渲染，不消失', async () => {
    const { render, sources } = renderStub()
    const warn = vi.fn()
    const translateLabels = async (): Promise<string[]> => {
      throw new Error('DeepSeek 不可达')
    }

    const plan = await composeOverlayPlan(labeledScene(), REGION, { render, translateLabels, logger: { warn, info: vi.fn() } })

    expect(sources[0]).toBe('graph LR\nA[流程甲] --> B[流程乙]')
    expect(plan.charts).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('节点文案翻译失败'))
  })

  it('一张图只发起一次翻译调用：全区域被拒后由裁剪候选兜底，不重译', async () => {
    // 渲染站只认不含正文的源码：全区域候选被拒后由裁剪候选（译文版）兜底，翻译仍只发生一次。
    const sources: string[] = []
    const render = async (source: string) => {
      sources.push(source)
      if (source.includes('正文')) {
        throw new Error('Lexical error on line 3')
      }
      return { svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }
    }
    const { translateLabels, requested } = labelTranslator({ 流程甲: 'Process A', 流程乙: 'Process B' })
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'A[流程甲] --> B[流程乙]', translation: '原文行', box: { x: 200, y: 125, width: 200, height: 20 } },
      { source: '这一段紧跟图后的正文。', translation: 'Trailing prose.', box: { x: 200, y: 150, width: 200, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render, translateLabels })

    expect(requested).toHaveLength(1)
    // 尝试序：候选1 译文版（正文拖挂被拒）→ 候选1 原文版（同样含正文，拒）→ 裁剪候选译文版（成功）。
    expect(sources).toEqual([
      'graph LR\nA[Process A] --> B[Process B]\n这一段紧跟图后的正文。',
      'graph LR\nA[流程甲] --> B[流程乙]\n这一段紧跟图后的正文。',
      'graph LR\nA[Process A] --> B[Process B]',
    ])
    expect(plan.charts).toHaveLength(1)
  })

  it('候选序列保守优先：全区域候选先试，合法非连线行（subgraph/participant）不被语句行过滤丢掉', async () => {
    // subgraph、participant、Note 等不是语句行，但也不是垃圾行：过滤候选若排在前且渲染成功，
    // 这些行的内容会从图里静默消失（裁剪后源码仍合法，渲染站裁决不出缺失）。
    const { render, sources } = renderStub()
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'subgraph One', translation: '子图', box: { x: 200, y: 125, width: 140, height: 20 } },
      { source: 'A --> B', translation: '甲到乙', box: { x: 200, y: 150, width: 140, height: 20 } },
      { source: 'end', translation: '结束', box: { x: 200, y: 175, width: 140, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render })

    expect(sources).toHaveLength(1)
    expect(sources[0]).toBe('graph LR\nsubgraph One\nA --> B\nend')
    expect(plan.charts).toHaveLength(1)
  })

  it('语句行过滤候选不含连线行时不产出：数字 id 劣化不再退化成裸声明空图', async () => {
    // OCR 把行首节点 id 认成数字起头时语句行判据放不过它们，过滤候选若只剩声明行，
    // 会渲染出一张空图盖住声明行。全区域候选先行成功，过滤候选根本不该存在。
    const { render, sources } = renderStub()
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: '4 --> 5', translation: '甲到乙', box: { x: 200, y: 125, width: 140, height: 20 } },
      { source: '6 --> 7', translation: '丙到丁', box: { x: 200, y: 150, width: 140, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render })

    expect(sources).toHaveLength(1)
    expect(sources[0]).toBe('graph LR\n4 --> 5\n6 --> 7')
    expect(plan.charts).toHaveLength(1)
  })

  it('整段皆语句行时候选序列退回全区域→砍尾，对照表仍一次建立', async () => {
    // 末行形如「id[标签]」（像语句、无箭头），语句行过滤产不出裁剪候选：首候选整段被渲染站拒后
    // 由砍尾候选兜底。对照表取自首个（全区域）候选，两个候选共享同一次翻译调用。
    const sources: string[] = []
    const render = async (source: string) => {
      sources.push(source)
      if (source.includes('正文')) {
        throw new Error('Lexical error on line 3')
      }
      return { svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }
    }
    const { translateLabels, requested } = labelTranslator({ 流程甲: 'Process A', 流程乙: 'Process B' })
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'A[流程甲] --> B[流程乙]', translation: '原文行', box: { x: 200, y: 125, width: 200, height: 20 } },
      { source: 'B1[图后紧跟的正文行]', translation: '残句行', box: { x: 200, y: 150, width: 200, height: 20 } },
    ]

    const plan = await composeOverlayPlan(blocks, REGION, { render, translateLabels })

    expect(requested).toHaveLength(1)
    // 尝试序：候选1 译文版（拒）→ 候选1 原文版（残句无译文映射仍含正文，拒）→ 候选2 译文版（成功）。
    expect(sources).toEqual([
      'graph LR\nA[Process A] --> B[Process B]\nB1[图后紧跟的正文行]',
      'graph LR\nA[流程甲] --> B[流程乙]\nB1[图后紧跟的正文行]',
      'graph LR\nA[Process A] --> B[Process B]',
    ])
    expect(plan.charts).toHaveLength(1)
  })

  it('译文让源码不合法时退回原文版本再试，图仍出来', async () => {
    // 渲染站只认原文源码：替译文版抛语法错，模拟翻译内容破坏结构。
    const sources: string[] = []
    const render = async (source: string) => {
      sources.push(source)
      if (source.includes('Process')) {
        throw new Error('Parse error on line 2')
      }
      return { svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }
    }
    const { translateLabels } = labelTranslator({ 流程甲: 'Process', 流程乙: 'Process B' })

    const plan = await composeOverlayPlan(labeledScene(), REGION, { render, translateLabels })

    // 先试译文版（被渲染站拒了），再试原文版成功。
    expect(sources).toEqual(['graph LR\nA[Process] --> B[Process B]', 'graph LR\nA[流程甲] --> B[流程乙]'])
    expect(plan.charts).toHaveLength(1)
  })

  it('图里没有节点标签时不发起翻译调用', async () => {
    const { render, sources } = renderStub()
    const { translateLabels, requested } = labelTranslator({})

    const plan = await composeOverlayPlan(scene(), REGION, { render, translateLabels })

    expect(requested).toHaveLength(0)
    expect(sources).toHaveLength(1)
    expect(plan.charts).toHaveLength(1)
  })

  it('译文条数与标签数不一致时按违约处理，回落原文渲染', async () => {
    const { render, sources } = renderStub()
    const warn = vi.fn()
    const translateLabels = async (labels: readonly string[]) => labels.slice(1)

    const plan = await composeOverlayPlan(labeledScene(), REGION, { render, translateLabels, logger: { warn, info: vi.fn() } })

    expect(sources[0]).toBe('graph LR\nA[流程甲] --> B[流程乙]')
    expect(plan.charts).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不一致'))
  })

  it('不注入翻译方即维持现状：图用识别到的原文源码渲染', async () => {
    const { render, sources } = renderStub()

    const plan = await composeOverlayPlan(labeledScene(), REGION, { render })

    expect(sources[0]).toBe('graph LR\nA[流程甲] --> B[流程乙]')
    expect(plan.charts).toHaveLength(1)
  })

  it('节点标签译文全为同文时，译文版与原文版是同一份源码，渲染站每个候选只收一次请求', async () => {
    // 中文标签经语言门控原文回填后，译文版源码与原文版逐字节相同；不去重的话渲染站拒第一条时
    // 第二条注定同样失败，白付一次往返。
    const { render, sources } = renderStub()
    const { translateLabels } = labelTranslator({})

    const plan = await composeOverlayPlan(labeledScene(), REGION, { render, translateLabels })

    expect(sources).toEqual(['graph LR\nA[流程甲] --> B[流程乙]'])
    expect(plan.charts).toHaveLength(1)
  })
})

describe('composeOverlayPlan · LLM 修复必经主送', () => {
  /** 修复替身：记录收到的源码，按给定结果作答。 */
  function refinerStub(result: string | ((source: string) => string)) {
    const inputs: string[] = []
    const refine = async (source: string) => {
      inputs.push(source)
      return typeof result === 'string' ? result : result(source)
    }
    return { refine, inputs }
  }

  function failingRefiner(message: string) {
    return async (): Promise<string> => {
      throw new Error(message)
    }
  }

  it('修复缺席（未注入）时行为与现状一致：尝试序列不带修复痕迹', async () => {
    const first = renderStub()
    await composeOverlayPlan(labeledSceneForRefine(), REGION, { render: first.render })
    const second = renderStub()
    // 注入一个与首候选逐字节相同的修复结果等价于没修：不该多送一次渲染
    const { refine } = refinerStub('graph LR\nA[流程甲] --> B[流程乙]')
    await composeOverlayPlan(labeledSceneForRefine(), REGION, { render: second.render, refine })
    expect(second.sources).toEqual(first.sources)
  })

  it('每张图恰调一次修复，吃的是全区域规则归一版', async () => {
    const { refine, inputs } = refinerStub('flowchart TD\nA[源甲] --> B[源乙]')
    const { render } = renderStub()
    await composeOverlayPlan(labeledSceneForRefine(), REGION, { render, refine })
    expect(inputs).toEqual(['graph LR\nA[流程甲] --> B[流程乙]'])
  })

  it('修复版主送：先试修复译标签版、再修复原文版，标签对照表改建在修复版上', async () => {
    // 渲染站拒掉译文版才轮得到修复原文版——两条都在场才证得了尝试次序。
    const sources: string[] = []
    const render = async (source: string) => {
      sources.push(source)
      if (source.includes('Alpha')) {
        throw new Error('Lexical error')
      }
      return { svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }
    }
    const { refine } = refinerStub('flowchart TD\nA[源甲] --> B[源乙]')
    const { translateLabels, requested } = labelTranslator({ 源甲: 'Alpha', 源乙: 'Beta' })
    const info = vi.fn()

    const plan = await composeOverlayPlan(labeledSceneForRefine(), REGION, {
      render,
      refine,
      translateLabels,
      logger: { warn: vi.fn(), info },
    })

    expect(requested).toEqual([['源甲', '源乙']])
    expect(sources[0]).toBe('flowchart TD\nA[Alpha] --> B[Beta]')
    expect(sources[1]).toBe('flowchart TD\nA[源甲] --> B[源乙]')
    expect(plan.charts[0]?.source).toBe(sources[1])
    expect(info).toHaveBeenCalledWith(expect.stringContaining('LLM 修复版'))
  })

  it('修复调用抛错时落回规则候选序列，与不注入时的尝试逐字节一致并把原因记进 warn', async () => {
    const baseline = renderStub()
    await composeOverlayPlan(labeledSceneForRefine(), REGION, { render: baseline.render })

    const after = renderStub()
    const warn = vi.fn()
    await composeOverlayPlan(labeledSceneForRefine(), REGION, {
      render: after.render,
      refine: failingRefiner('DeepSeek 请求失败'),
      logger: { warn, info: vi.fn() },
    })

    expect(after.sources).toEqual(baseline.sources)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('LLM 修复失败'))
  })

  it('修复版被渲染站拒绝时继续落规则候选，最终带出的是实际成功的规则版源码', async () => {
    const sources: string[] = []
    const render = async (source: string) => {
      sources.push(source)
      if (source.startsWith('flowchart')) {
        throw new Error('Lexical error')
      }
      return { svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }
    }
    const { refine } = refinerStub('flowchart TD\nA[源甲] --> B[源乙]')
    const info = vi.fn()

    const plan = await composeOverlayPlan(labeledSceneForRefine(), REGION, { render, refine, logger: { warn: vi.fn(), info } })

    expect(plan.charts[0]?.source).toBe('graph LR\nA[流程甲] --> B[流程乙]')
    expect(info).toHaveBeenCalledWith(expect.stringContaining('规则候选'))
  })

  it('多条 mermaid 时逐图各修一次', async () => {
    // 两图之间留一空行观察：检测以空行划界，紧贴无分隔的双声明场景现状只产第一张（既有行为）。
    const blocks: OverlayBlock[] = [
      { source: 'graph LR', translation: '', box: { x: 200, y: 100, width: 80, height: 20 } },
      { source: 'A --> B', translation: '', box: { x: 200, y: 125, width: 140, height: 20 } },
      { source: '', translation: '', box: { x: 200, y: 150, width: 10, height: 20 } },
      { source: 'graph TD', translation: '', box: { x: 200, y: 175, width: 80, height: 20 } },
      { source: 'C --> D', translation: '', box: { x: 200, y: 200, width: 140, height: 20 } },
    ]
    const { refine, inputs } = refinerStub((source) => source.replace('-->', '--->'))
    const { render } = renderStub()
    await composeOverlayPlan(blocks, REGION, { render, refine })
    expect(inputs).toHaveLength(2)
  })
})

/** 修复用例共用的一块带标签图。 */
function labeledSceneForRefine(): OverlayBlock[] {
  return [
    { source: 'graph LR', translation: '图声明', box: { x: 200, y: 100, width: 80, height: 20 } },
    { source: 'A[流程甲] --> B[流程乙]', translation: '原文行', box: { x: 200, y: 125, width: 200, height: 20 } },
  ]
}
