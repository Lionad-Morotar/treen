// @vitest-environment jsdom
import { defineComponent, h } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DevChartStep from '../app/components/dev/DevChartStep.vue'
import type { ChartSource, OverlayChartItem } from '../app/utils/dev-pipeline-overlay'

/**
 * 图表步骤的组件级行为。
 *
 * 这里守的是两条真实形态下的回归：服务端交回的 `ChartPlacement` 里没有 `intrinsic`，模板若还读
 * 它，真实响应一来整页就崩——而只测纯函数测不出来，因为崩的是渲染期；以及浏览器侧渲染失败后
 * 重试入口不能被封死，OCR 出的源码不合法是这条链路的常态。mermaid 用替身：真渲染要 DOM/CSS 布局。
 */

const mermaidStub = vi.hoisted(() => ({ calls: [] as string[], fail: false }))

vi.mock('mermaid', () => ({
  default: {
    initialize: () => {},
    render: async (_id: string, source: string) => {
      mermaidStub.calls.push(source)
      if (mermaidStub.fail) {
        throw new Error('Lexical error on line 2')
      }
      return { svg: '<svg viewBox="0 0 10 5"></svg>' }
    },
  },
}))

const DevRawError = defineComponent({
  props: { failure: { type: Object, default: null } },
  setup(props) {
    return () => h('pre', { 'data-testid': 'stub-raw-error' }, String(props.failure?.raw ?? ''))
  },
})

/** 服务端真实形态的版位：只有 x/y/width/height/svg，没有 intrinsic。 */
const CHART: OverlayChartItem = {
  svg: '<svg viewBox="0 0 120 60"></svg>',
  x: 5,
  y: 6,
  width: 70,
  height: 35,
}

function mountStep(charts: OverlayChartItem[], sources: ChartSource[]): VueWrapper {
  return mount(DevChartStep, {
    attachTo: document.body,
    props: { charts, sources, diagnostics: [], failure: null, disabled: false },
    global: { components: { DevRawError } },
  })
}

let wrapper: VueWrapper

beforeEach(() => {
  mermaidStub.calls = []
  mermaidStub.fail = false
})

describe('图表步骤对真实响应的呈现', () => {
  it('版位里没有 intrinsic 时照常渲染，固有尺寸从 SVG 的 viewBox 读', () => {
    wrapper = mountStep([CHART], [{ source: 'graph LR\nA --> B', exact: true }])

    const row = wrapper.get('[data-testid="dev-pipeline-chart-0"]')
    expect(row.text()).toContain('版位 5,6')
    expect(row.text()).toContain('70×35')
    // 服务端不交 intrinsic，固有尺寸只可能来自 SVG 自身；读到 120×60 即证明不再依赖那个字段。
    expect(row.text()).toContain('固有 120×60')
  })

  it('SVG 里读不出 viewBox 时照实标注，不崩也不拿版位顶上', () => {
    wrapper = mountStep(
      [{ ...CHART, svg: '<svg></svg>' }],
      [{ source: 'graph LR\nA --> B', exact: true }],
    )

    expect(wrapper.get('[data-testid="dev-pipeline-chart-0"]').text()).toContain('固有 读不出')
  })

  it('源码不是服务端那份时标出「还原」，是那份时不标', () => {
    wrapper = mountStep([CHART], [{ source: 'graph LR\nA --> B', exact: false }])
    expect(wrapper.find('[data-testid="dev-pipeline-chart-source-restored-0"]').exists()).toBe(true)

    wrapper.unmount()
    wrapper = mountStep([CHART], [{ source: 'graph LR\nA --> B', exact: true }])
    expect(wrapper.find('[data-testid="dev-pipeline-chart-source-restored-0"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="dev-pipeline-chart-source-0"]').text()).toBe('graph LR\nA --> B')
  })
})

describe('浏览器侧重渲', () => {
  const SOURCES: ChartSource[] = [{ source: 'graph LR\nA --> B', exact: true }]

  it('切到浏览器侧渲一次，不出来就再点一次', async () => {
    wrapper = mountStep([CHART], SOURCES)

    mermaidStub.fail = true
    await wrapper.get('[data-testid="dev-pipeline-chart-path-browser"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="dev-pipeline-chart-browser-error"]').exists()).toBe(true)
    })
    expect(mermaidStub.calls).toHaveLength(1)

    // 失败后按钮语义变成重新渲染；这里若还被 browserAttempted 守着，就再也点不动了。
    expect(wrapper.get('[data-testid="dev-pipeline-chart-path-browser"]').text()).toContain('重新渲染')

    await wrapper.get('[data-testid="dev-pipeline-chart-path-browser"]').trigger('click')
    await vi.waitFor(() => {
      expect(mermaidStub.calls).toHaveLength(2)
    })
    expect(wrapper.find('[data-testid="dev-pipeline-chart-browser-error"]').exists()).toBe(true)

    mermaidStub.fail = false
    await wrapper.get('[data-testid="dev-pipeline-chart-path-browser"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="dev-pipeline-chart-browser-0"]').exists()).toBe(true)
    })
    expect(mermaidStub.calls).toHaveLength(3)
    expect(wrapper.find('[data-testid="dev-pipeline-chart-browser-error"]').exists()).toBe(false)
  })

  it('送渲染的是源码本身，失败重试不会把上一次的错误信息留在屏幕上', async () => {
    wrapper = mountStep([CHART], SOURCES)

    mermaidStub.fail = true
    await wrapper.get('[data-testid="dev-pipeline-chart-path-browser"]').trigger('click')
    await vi.waitFor(() => {
      expect(mermaidStub.calls).toEqual(['graph LR\nA --> B'])
    })

    mermaidStub.fail = false
    await wrapper.get('[data-testid="dev-pipeline-chart-path-browser"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-testid="dev-pipeline-chart-browser-0"]').exists()).toBe(true)
    })
  })
})
