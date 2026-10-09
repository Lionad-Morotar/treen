import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import type { OverlayPlan } from '../src/overlay/layout'

/**
 * overlay.html 的渲染面测试：把真实文件载进 jsdom（执行内联脚本），调用主进程注入用的
 * `__treenSetOverlay`，断言 DOM 结果。布局数学已在 overlay-layout.spec 覆盖，这里只钉
 * 「算好的计划如何落到 DOM」——绝对定位、字号、折行输出、SVG 承载、越权重注入。
 *
 * 桌面程序刻意不带 lib.dom（见 mermaid/jsdom.d.ts 的理由），故这里用结构化最小接口描述
 * 用到的 DOM 面，不引全局 DOM 类型。
 */

interface StyleLike {
  left: string
  top: string
  width: string
  height: string
  fontSize: string
  lineHeight: string
  fontFamily: string
  setProperty(name: string, value: string, priority?: string): void
  getPropertyValue(name: string): string
  getPropertyPriority(name: string): string
}

interface ElementList {
  readonly length: number
  [index: number]: ElementLike
}

interface ElementLike {
  style: StyleLike
  textContent: string | null
  /** html.hidden 是显隐开关：loading 层的显示面就是它的翻转 */
  hidden: boolean
  getAttribute(name: string): string | null
  querySelector(selector: string): ElementLike | null
  querySelectorAll(selector: string): ElementList
  readonly children: ElementList
}

interface DocumentLike {
  querySelector(selector: string): ElementLike | null
  querySelectorAll(selector: string): ElementList
}

interface ComputedStyleLike {
  borderTopWidth: string
  getPropertyValue(name: string): string
}

interface WindowLike {
  document: DocumentLike
  getComputedStyle(element: ElementLike): ComputedStyleLike
  __treenSetOverlay(plan: unknown): void
  __treenSetLoading(rect: unknown): void
  __treenClearLoading(rect: unknown): void
}

const OVERLAY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'overlay.html')

function loadOverlay(): { layer: ElementLike; loading: ElementLike; window: WindowLike } {
  const html = readFileSync(OVERLAY_PATH, 'utf8')
  // 变量中转：本地 jsdom 声明只列了 pretendToBeVisual，这里额外开 runScripts 让内联脚本执行。
  const options = { runScripts: 'dangerously' as const, pretendToBeVisual: true }
  const dom = new JSDOM(html, options)
  const window = dom.window as unknown as WindowLike
  const layer = window.document.querySelector('[data-testid="freeze-overlay"]')
  if (layer === null) {
    throw new Error('overlay.html 缺少 #treen-overlay 容器')
  }
  const loading = window.document.querySelector('[data-testid="freeze-loading"]')
  if (loading === null) {
    throw new Error('overlay.html 缺少 #treen-loading 容器')
  }
  return { layer, loading, window }
}

const CHART_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50"/></svg>'

function planWith(texts: OverlayPlan['texts'], charts: OverlayPlan['charts']): OverlayPlan {
  return { fontFamily: 'Menlo, monospace', lineHeightRatio: 1.25, texts, charts }
}

function toArray(list: ElementList): ElementLike[] {
  return Array.from({ length: list.length }, (_, index) => list[index] as ElementLike)
}

describe('overlay.html 的覆盖渲染', () => {
  it('把译文版位落成绝对定位、字号与逐行文本', () => {
    const { layer, window } = loadOverlay()

    window.__treenSetOverlay(
      planWith(
        [
          {
            x: 12,
            y: 34,
            width: 100,
            height: 40,
            fontSize: 10,
            lineHeight: 12.5,
            lines: ['第一行', '第二行'],
            clipped: false,
          },
        ],
        [],
      ),
    )

    const boxes = toArray(layer.querySelectorAll('[data-testid="freeze-text"]'))
    expect(boxes).toHaveLength(1)
    const box = boxes[0]!
    expect(box.style.left).toBe('12px')
    expect(box.style.top).toBe('34px')
    expect(box.style.width).toBe('100px')
    expect(box.style.height).toBe('40px')
    expect(box.style.fontSize).toBe('10px')
    expect(box.style.lineHeight).toBe('12.5px')
    expect(box.style.fontFamily).toContain('monospace')

    const lines = toArray(box.querySelectorAll('[data-testid="freeze-text-line"]'))
    expect(lines.map((line) => line.textContent)).toEqual(['第一行', '第二行'])
  })

  it('译文盒的描边不占内容宽度，折行按盒宽算的行不会被切掉尾巴', () => {
    const { layer, window } = loadOverlay()

    window.__treenSetOverlay(
      planWith(
        [
          {
            x: 0,
            y: 0,
            width: 100,
            height: 20,
            fontSize: 10,
            lineHeight: 12.5,
            lines: ['铺满整行的一段文字'],
            clipped: false,
          },
        ],
        [],
      ),
    )

    const style = window.getComputedStyle(layer.querySelector('[data-testid="freeze-text"]')!)
    // border 会从盒内吃掉 1px（box-sizing: border-box），内容区窄于主进程折行时用的盒宽；
    // 描边改走 outline 后不参与布局，这里钉住「没有占宽的边框」这个前提。
    expect(style.borderTopWidth).toBe('0px')
  })

  it('clipped 的译文盒带上可断言的标记', () => {
    const { layer, window } = loadOverlay()

    window.__treenSetOverlay(
      planWith(
        [
          {
            x: 0,
            y: 0,
            width: 40,
            height: 10,
            fontSize: 6,
            lineHeight: 7.5,
            lines: ['放不下的一段'],
            clipped: true,
          },
        ],
        [],
      ),
    )

    const box = layer.querySelector('[data-testid="freeze-text"]')
    expect(box?.getAttribute('data-clipped')).toBe('true')
  })

  it('把图版位落成承载 SVG 的绝对定位盒，SVG 按承载尺寸铺满', () => {
    const { layer, window } = loadOverlay()

    window.__treenSetOverlay(planWith([], [{ x: 100, y: 50, width: 200, height: 100, svg: CHART_SVG }]))

    const holders = toArray(layer.querySelectorAll('[data-testid="freeze-chart"]'))
    expect(holders).toHaveLength(1)
    const holder = holders[0]!
    expect(holder.style.left).toBe('100px')
    expect(holder.style.width).toBe('200px')

    const svg = holder.querySelector('svg')
    expect(svg).not.toBeNull()
    // 承载尺寸用 important 强制，压过 mermaid 可能带的内联 max-width。
    expect(svg!.style.getPropertyValue('width')).toBe('200px')
    expect(svg!.style.getPropertyPriority('width')).toBe('important')
  })

  it('坏 SVG 不产出空盒，允许的图照常落位', () => {
    const { layer, window } = loadOverlay()

    window.__treenSetOverlay(
      planWith([], [
        { x: 0, y: 0, width: 10, height: 10, svg: 'not-an-svg' },
        { x: 20, y: 20, width: 10, height: 10, svg: CHART_SVG },
      ]),
    )

    expect(toArray(layer.querySelectorAll('[data-testid="freeze-chart"]'))).toHaveLength(1)
  })

  it('重注入整批替换旧内容，不累积', () => {
    const { layer, window } = loadOverlay()
    const one = {
      x: 0,
      y: 0,
      width: 40,
      height: 20,
      fontSize: 8,
      lineHeight: 10,
      lines: ['一'],
      clipped: false,
    }

    window.__treenSetOverlay(planWith([one], []))
    window.__treenSetOverlay(planWith([one, { ...one, lines: ['二'] }], []))

    expect(toArray(layer.querySelectorAll('[data-testid="freeze-text"]'))).toHaveLength(2)
  })

  it('形状不合的条目被跳过，不抛错', () => {
    const { layer, window } = loadOverlay()

    window.__treenSetOverlay({
      fontFamily: '',
      lineHeightRatio: 1.25,
      texts: [
        { x: 0, y: 0, width: 0, height: 20, fontSize: 8, lineHeight: 10, lines: ['零宽'], clipped: false },
        'garbage',
      ],
      charts: [],
    })

    expect(toArray(layer.querySelectorAll('[data-testid="freeze-text"]'))).toHaveLength(0)
  })

  it('非对象计划即清空，不残留上一个计划', () => {
    const { layer, window } = loadOverlay()
    window.__treenSetOverlay(
      planWith(
        [{ x: 0, y: 0, width: 40, height: 20, fontSize: 8, lineHeight: 10, lines: ['旧'], clipped: false }],
        [],
      ),
    )

    window.__treenSetOverlay(null)

    expect(layer.children.length).toBe(0)
  })
})

describe('overlay.html 的翻译 loading 层', () => {
  const RECT = { x: 12, y: 34, width: 200, height: 100 }

  it('loading 层在页面里唯一且初始隐藏', () => {
    const { loading, window } = loadOverlay()

    expect(loading.hidden).toBe(true)
    expect(window.document.querySelectorAll('[data-testid="freeze-loading"]').length).toBe(1)
  })

  it('显示时把层摆到给定区域并解除隐藏', () => {
    const { loading, window } = loadOverlay()

    window.__treenSetLoading(RECT)

    expect(loading.hidden).toBe(false)
    expect(loading.style.left).toBe('12px')
    expect(loading.style.top).toBe('34px')
    expect(loading.style.width).toBe('200px')
    expect(loading.style.height).toBe('100px')
  })

  it('自己的区域收线后隐藏且不残留，重新显示可复用同一层', () => {
    const { loading, window } = loadOverlay()

    window.__treenSetLoading(RECT)
    window.__treenClearLoading(RECT)
    expect(loading.hidden).toBe(true)

    const moved = { x: 0, y: 0, width: 50, height: 60 }
    window.__treenSetLoading(moved)
    expect(loading.hidden).toBe(false)
    expect(loading.style.width).toBe('50px')
  })

  it('旧区域的收线动不到新区域正在扫的线（同屏连点竞态）', () => {
    const { loading, window } = loadOverlay()

    window.__treenSetLoading(RECT)
    const moved = { x: 0, y: 0, width: 50, height: 60 }
    window.__treenSetLoading(moved)

    window.__treenClearLoading(RECT)
    expect(loading.hidden).toBe(false)
    expect(loading.style.width).toBe('50px')

    window.__treenClearLoading(moved)
    expect(loading.hidden).toBe(true)
  })

  it('未显示时收线是静默 no-op', () => {
    const { loading, window } = loadOverlay()

    window.__treenClearLoading(RECT)
    expect(loading.hidden).toBe(true)
  })

  it('形状不合的 rect 一律当隐藏处理，不把坏值写进样式', () => {
    const { loading, window } = loadOverlay()

    window.__treenSetLoading(RECT)
    window.__treenSetLoading({ x: 1, y: 2 })
    expect(loading.hidden).toBe(true)

    window.__treenSetLoading('garbage')
    expect(loading.hidden).toBe(true)

    // 坏值没有污染上一次的好位置：重新显示直接落新几何。
    window.__treenSetLoading(RECT)
    expect(loading.style.left).toBe('12px')
    expect(loading.hidden).toBe(false)
  })

  it('连续显示不同区域只更新几何，不产生第二个层', () => {
    const { loading, window } = loadOverlay()

    window.__treenSetLoading(RECT)
    window.__treenSetLoading({ x: 1, y: 1, width: 9, height: 9 })

    expect(window.document.querySelectorAll('[data-testid="freeze-loading"]').length).toBe(1)
    expect(loading.style.left).toBe('1px')
  })
})
