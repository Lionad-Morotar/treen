import { describe, expect, it } from 'vitest'
import {
  chartSourceOf,
  chartSourcesOf,
  overlayScaleOf,
  overlayStyleOf,
  overlayTextStyleOf,
  svgIntrinsicOf,
  type OverlayChartItem,
  type OverlayTextItem,
} from '../app/utils/dev-pipeline-overlay'

/**
 * 覆盖层预览的换算与图表源码还原。
 *
 * 这两件事错了都不会报错，只会让覆盖层「看起来差不多」：坐标按原图像素算却在缩放后的图上落点，
 * 整体偏移随缩放比例放大；源码取错行则浏览器侧渲出的图与服务端那张不是同一张，对比就失去意义。
 * 故抽成纯函数单独覆盖，页面组件里不留算术。
 */

const BOX = { x: 100, y: 200, width: 300, height: 150 }

function textItem(overrides: Partial<OverlayTextItem> = {}): OverlayTextItem {
  return {
    x: 10,
    y: 20,
    width: 60,
    height: 24,
    translation: '译文',
    lines: ['译文'],
    fontSize: 16,
    lineHeight: 20,
    clipped: false,
    ...overrides,
  }
}

describe('覆盖层的缩放换算', () => {
  it('原图按一半宽度显示时，坐标与字号一并折半', () => {
    expect(overlayScaleOf(400, 800)).toBe(0.5)

    expect(overlayStyleOf(BOX, 0.5)).toEqual({
      left: '50px',
      top: '100px',
      width: '150px',
      height: '75px',
    })
    expect(overlayTextStyleOf(textItem(), 0.5)).toEqual({
      left: '5px',
      top: '10px',
      width: '30px',
      height: '12px',
      fontSize: '8px',
      lineHeight: '10px',
    })
  })

  it('原尺寸显示时比例为一，定位即原始像素', () => {
    expect(overlayScaleOf(800, 800)).toBe(1)
    expect(overlayStyleOf(BOX, 1)).toEqual({
      left: '100px',
      top: '200px',
      width: '300px',
      height: '150px',
    })
  })

  /**
   * 图还没解码出来时 naturalWidth 是 0，除出来的 Infinity/NaN 会变成 `left: NaNpx`，
   * 浏览器整片覆盖层静默塌陷。宁可按 1 落一次错位，也不要 NaN。
   */
  it('拿不到原始宽度时退回比例 1，不产生 NaN 定位', () => {
    expect(overlayScaleOf(0, 0)).toBe(1)
    expect(overlayScaleOf(400, 0)).toBe(1)
    expect(overlayStyleOf(BOX, overlayScaleOf(0, 0)).left).toBe('100px')
  })
})

describe('图表源码的还原', () => {
  const BLOCKS = [
    { text: 'Title', box: { x: 0, y: 0, width: 60, height: 20 } },
    { text: 'graph LR', box: { x: 200, y: 100, width: 80, height: 20 } },
    { text: 'A --> B', box: { x: 200, y: 125, width: 140, height: 20 } },
    { text: '正文一段', box: { x: 0, y: 300, width: 200, height: 20 } },
  ]

  // 版位与服务端 RealShape 同形：只有 x/y/width/height/svg，没有 intrinsic。
  const CHART: OverlayChartItem = {
    svg: '<svg viewBox="0 0 140 60"></svg>',
    x: 200,
    y: 100,
    width: 140,
    height: 45,
  }

  it('只取中心落在图版位里的行，按行序拼成源码', () => {
    expect(chartSourceOf(BLOCKS, CHART)).toBe('graph LR\nA --> B')
  })

  it('版位里没有行时给空串，而不是拿整屏文本凑一段必然渲染失败的源码', () => {
    expect(chartSourceOf(BLOCKS, { x: 900, y: 900, width: 10, height: 10 })).toBe('')
  })

  it('多张图逐张还原，条数与版位一致', () => {
    const other = { ...CHART, x: 0, y: 295, width: 200, height: 30 }

    expect(chartSourcesOf(BLOCKS, [CHART, other])).toEqual([
      { source: 'graph LR\nA --> B', exact: false },
      { source: '正文一段', exact: false },
    ])
  })

  it('服务端把渲染成功的源码带出来时优先用它，不再按中心点还原', () => {
    const withSource: OverlayChartItem = { ...CHART, source: 'graph LR\nA[甲] --> B[乙]' }

    // 这行是相邻图声明行：按中心点归属会被收进源码，而它已被 chartRegionMembers 的 stopAt 排除。
    const blocks = [
      ...BLOCKS,
      { text: 'graph TD', box: { x: 200, y: 140, width: 80, height: 20 } },
    ]

    expect(chartSourcesOf(blocks, [withSource])).toEqual([
      { source: 'graph LR\nA[甲] --> B[乙]', exact: true },
    ])
  })

  it('没有图时没有源码', () => {
    expect(chartSourcesOf(BLOCKS, [])).toEqual([])
  })
})

describe('图表固有尺寸的读取', () => {
  it('从 SVG 的 viewBox 读固有尺寸', () => {
    expect(svgIntrinsicOf('<svg viewBox="0 0 140 60"></svg>')).toEqual({ width: 140, height: 60 })
    expect(svgIntrinsicOf('<svg viewBox="-10 -20 200 100"></svg>')).toEqual({
      width: 200,
      height: 100,
    })
  })

  it('没有 viewBox 时退回根元素的宽高属性', () => {
    expect(svgIntrinsicOf('<svg width="320" height="180"></svg>')).toEqual({
      width: 320,
      height: 180,
    })
  })

  it('都读不出时返回 null，不拿版位尺寸顶上', () => {
    expect(svgIntrinsicOf('<svg width="100%"></svg>')).toBeNull()
    expect(svgIntrinsicOf('<svg />')).toBeNull()
  })
})
