import { describe, expect, it } from 'vitest'
import { MermaidRenderError, renderMermaidSvg } from '../server/utils/mermaid-render'

describe('renderMermaidSvg', () => {
  it('渲染出含 svg 与可读 viewBox 的产物', async () => {
    const result = await renderMermaidSvg('graph LR\n A[开始] --> B[结束]')
    expect(result.svg).toContain('<svg')
    expect(/viewBox="(-?[\d.]+ ){3}-?[\d.]+"/.test(result.svg)).toBe(true)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  it('图表宽度随节点文字变长而增长（几何随内容变化，非固定占位）', async () => {
    const short = await renderMermaidSvg('graph LR\n A[a] --> B[b]')
    const long = await renderMermaidSvg('graph LR\n A[一段相当长的节点标签内容] --> B[另一段同样不短的标签]')
    expect(long.width).toBeGreaterThan(short.width)
  })

  it('几何与真机 Chromium 对齐（viewBox 逐像素级吻合）', async () => {
    // 基准由 Electron（真实 Chromium）用同一份 MERMAID_RENDER_CONFIG 渲出后实测：
    // 同一源码 viewBox = "4 4 505.3125 59"。服务端纯 Node 渲染须复现同一几何，
    // 否则产出物会带多余留白或裁切。容差半像素，覆盖等宽字体度量的舍入。
    const { svg } = await renderMermaidSvg('graph LR\n A[abcdefghijklmnopqrst] --> B[abcdefghijklmnopqrst]')
    const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? ''
    const [x = NaN, y = NaN, width = NaN, height = NaN] = viewBox.trim().split(/\s+/).map(Number)
    expect(x).toBeCloseTo(4, 0)
    expect(y).toBeCloseTo(4, 0)
    expect(width).toBeCloseTo(505.3125, 0)
    expect(height).toBeCloseTo(59, 0)
  })

  it('空源码被拒（400）', async () => {
    const error = await renderMermaidSvg('   ').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MermaidRenderError)
    expect((error as MermaidRenderError).statusCode).toBe(400)
  })

  it('非法源码被拒（422）', async () => {
    const error = await renderMermaidSvg('graph LR\n A -->').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MermaidRenderError)
    expect((error as MermaidRenderError).statusCode).toBe(422)
  })

  it('源码里的 init 注入改不动配色（剥离在渲染前生效）', async () => {
    const injected = '%%{init: {"themeVariables": {"primaryColor": "#ff0000"}}}%%\ngraph LR\n A --> B'
    const { svg } = await renderMermaidSvg(injected)
    expect(svg.toLowerCase()).not.toContain('#ff0000')
    expect(svg.toLowerCase()).not.toContain('ff0000')
  })
})
