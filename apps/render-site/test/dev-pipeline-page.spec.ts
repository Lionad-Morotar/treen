// @vitest-environment jsdom
import { defineComponent, h, type PropType } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { RENDER_SITE_DEV_ROUTES, RENDER_SITE_ROUTES } from '@treen/ipc/routes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DevPipelinePage from '../app/pages/dev/pipeline.vue'
import type { EditableBlock, TranslationPair } from '../app/utils/dev-pipeline-format'
import type { OverlayChartItem } from '../app/utils/dev-pipeline-overlay'

/**
 * `/dev/pipeline` 页面的组件级行为测试。
 *
 * 只有挂在组件上才测得准的三件事：换图/清图要作废下游结果、粘贴取图不能抢走输入框里的
 * Cmd+V、样本库 404 的空态指向门禁而不是路由注册。前两条是「状态怎么被改」而不是「函数算得
 * 对不对」，抽成纯函数反而测不到真实链路，故这里挂真页面、把四个子组件换成只留可断言节点的
 * 替身（子组件的排版与格式化另有单测面）。fetch 全程用替身：翻译端点真会调计费的外部 API。
 */

/** 面板替身：只留下操作区与默认插槽，折叠态与耗时排版不在本测试的关注面。 */
const DevPanel = defineComponent({
  setup(_props, { slots }) {
    return () => [slots.actions?.(), slots.default?.()]
  },
})

const DevImageSource = defineComponent({
  props: {
    imageName: { type: String as PropType<string | null>, default: null },
    samplesHint: { type: String, default: '' },
  },
  emits: ['clear'],
  setup(props, { emit }) {
    return () => [
      h('span', { 'data-testid': 'stub-image' }, props.imageName ?? 'none'),
      h('span', { 'data-testid': 'stub-samples-hint' }, props.samplesHint),
      props.imageName === null
        ? null
        : h(
            'button',
            { type: 'button', 'data-testid': 'stub-clear', onClick: () => emit('clear') },
            '清除',
          ),
    ]
  },
})

const DevOcrStep = defineComponent({
  props: { blocks: { type: Array as PropType<EditableBlock[]>, default: () => [] } },
  setup(props) {
    return () => [
      h('span', { 'data-testid': 'stub-block-count' }, String(props.blocks.length)),
      ...props.blocks.map((block, index) =>
        h('input', { 'data-testid': `stub-block-text-${index}`, value: block.text }),
      ),
    ]
  },
})

const DevTranslateStep = defineComponent({
  props: { pairs: { type: Array as PropType<TranslationPair[]>, default: () => [] } },
  setup(props) {
    return () => h('span', { 'data-testid': 'stub-pair-count' }, String(props.pairs.length))
  },
})

const DevChartStep = defineComponent({
  props: {
    charts: { type: Array as PropType<OverlayChartItem[]>, default: () => [] },
    diagnostics: { type: Array as PropType<string[]>, default: () => [] },
  },
  setup(props) {
    return () => [
      h('span', { 'data-testid': 'stub-chart-count' }, String(props.charts.length)),
      h('span', { 'data-testid': 'stub-diagnostics-count' }, String(props.diagnostics.length)),
    ]
  },
})

const DevOverlayPreview = defineComponent({
  props: {
    texts: { type: Array as PropType<unknown[]>, default: () => [] },
    charts: { type: Array as PropType<OverlayChartItem[]>, default: () => [] },
  },
  setup(props) {
    return () => [
      h('span', { 'data-testid': 'stub-overlay-text-count' }, String(props.texts.length)),
      h('span', { 'data-testid': 'stub-overlay-chart-count' }, String(props.charts.length)),
    ]
  },
})

const BLOCK = {
  text: 'Hello',
  confidence: 0.9,
  box: { x: 1, y: 2, width: 3, height: 4 },
}

interface FetchCall {
  url: string
  body: unknown
}

let calls: FetchCall[] = []

/** 各端点的正常应答；`Response` 形态留给想显式摆状态码的用例。 */
function payloadOf(url: string): unknown {
  if (url === RENDER_SITE_ROUTES.health) {
    return { ok: true, service: 'render-site', version: '0.0.0' }
  }
  if (url === RENDER_SITE_DEV_ROUTES.samples) {
    return { root: '/zRefs', samples: [] }
  }
  if (url === RENDER_SITE_DEV_ROUTES.ocr) {
    return { blocks: [BLOCK], elapsedMs: 12 }
  }
  if (url === RENDER_SITE_DEV_ROUTES.translate) {
    return { translations: ['你好'], gated: [false] }
  }
  if (url === RENDER_SITE_DEV_ROUTES.pipeline) {
    return {
      blocks: [BLOCK],
      translations: ['你好'],
      plan: {
        fontFamily: 'monospace',
        lineHeightRatio: 1.25,
        texts: [{ translation: '你好', x: 1, y: 2, width: 3, height: 4, fontSize: 8, lineHeight: 10, lines: ['你好'], clipped: false }],
        // 与服务端 OverlayPlan 逐字段同形：ChartPlacement 没有 intrinsic，固有尺寸在 viewBox 里。
        charts: [{ svg: '<svg viewBox="0 0 20 10"></svg>', x: 5, y: 6, width: 7, height: 8, source: 'graph LR\nA --> B' }],
      },
      timings: { ocrMs: 1, translateMs: 2, chartMs: 3 },
      diagnostics: [],
    }
  }
  return {}
}

/** 替掉 fetch：既给可断言的调用记录，也免得单测真去打计费的外部翻译 API。应答允许异步以便卡住在途态。 */
function stubFetch(respond: (url: string) => unknown | Promise<unknown>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({
      url,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    })
    const result = await respond(url)
    if (result instanceof Response) {
      return result
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/**
 * 造一个 PNG：页面只按 type 与扩展名收图、不解码像素，故一个签名头足够走完收图链路。
 * 末字节取自文件名，好让两张测试图的 data URL 真的不同——换图判定按图的数据指纹比对，
 * 字节一样的两张图会被当成同一张，「换过图」这件事就测不出来。
 */
function imageFile(name: string): File {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, name.charCodeAt(0) & 0xff]
  return new File([new Uint8Array(signature)], name, {
    type: 'image/png',
  })
}

/** 派发一个带 clipboardData 的 paste：jsdom 不实现 ClipboardEvent，故只补页面读的那一个字段。 */
function paste(target: EventTarget, file: File | null): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { files: { item: () => file } },
  })
  target.dispatchEvent(event)
  return event
}

function textOf(wrapper: VueWrapper, testId: string): string {
  return wrapper.get(`[data-testid="${testId}"]`).text()
}

/** 读文件走 FileReader，落点不在一个 tick 内；轮询到状态落地比猜要等几轮稳。 */
async function untilText(wrapper: VueWrapper, testId: string, expected: string): Promise<void> {
  await vi.waitFor(() => {
    expect(textOf(wrapper, testId)).toBe(expected)
  })
}

let wrapper: VueWrapper

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', stubFetch(payloadOf))
})

afterEach(() => {
  wrapper?.unmount()
  vi.unstubAllGlobals()
})

function mountPage(): VueWrapper {
  return mount(DevPipelinePage, {
    attachTo: document.body,
    global: {
      components: { DevPanel, DevImageSource, DevOcrStep, DevTranslateStep, DevChartStep, DevOverlayPreview },
    },
  })
}

describe('dev/pipeline 的取图与下游结果', () => {
  it('清图后识别块与译文一并作废，翻译按钮点不动也不再打计费端点', async () => {
    wrapper = mountPage()

    const loaded = paste(window, imageFile('a.png'))
    expect(loaded.defaultPrevented).toBe(true)
    await untilText(wrapper, 'stub-image', 'a.png')

    await wrapper.get('[data-testid="dev-pipeline-ocr-run"]').trigger('click')
    await untilText(wrapper, 'stub-block-count', '1')

    await wrapper.get('[data-testid="dev-pipeline-translate-run"]').trigger('click')
    await untilText(wrapper, 'stub-pair-count', '1')
    const translateCalls = () => calls.filter((call) => call.url === RENDER_SITE_DEV_ROUTES.translate)
    expect(translateCalls()).toHaveLength(1)

    await wrapper.get('[data-testid="stub-clear"]').trigger('click')

    expect(textOf(wrapper, 'stub-image')).toBe('none')
    expect(textOf(wrapper, 'stub-block-count')).toBe('0')
    expect(textOf(wrapper, 'stub-pair-count')).toBe('0')
    // 图都没了，这一步只能是禁用态：留着可点就会把一张已不存在的图的文本送给计费 API。
    expect(
      wrapper.get('[data-testid="dev-pipeline-translate-run"]').attributes('disabled'),
    ).toBeDefined()

    await wrapper.get('[data-testid="dev-pipeline-translate-run"]').trigger('click')
    expect(translateCalls()).toHaveLength(1)
  })

  it('焦点在识别框里时粘贴不换图，焦点在页面空白处才接管', async () => {
    wrapper = mountPage()

    paste(window, imageFile('a.png'))
    await untilText(wrapper, 'stub-image', 'a.png')
    await wrapper.get('[data-testid="dev-pipeline-ocr-run"]').trigger('click')
    await untilText(wrapper, 'stub-block-count', '1')

    const input = wrapper.get('[data-testid="stub-block-text-0"]').element as HTMLInputElement
    input.focus()
    expect(document.activeElement).toBe(input)

    const onInput = paste(document.activeElement ?? document.body, imageFile('b.png'))
    expect(onInput.defaultPrevented).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(textOf(wrapper, 'stub-image')).toBe('a.png')
    expect(textOf(wrapper, 'stub-block-count')).toBe('1')

    const onPage = paste(document.body, imageFile('b.png'))
    expect(onPage.defaultPrevented).toBe(true)
    await untilText(wrapper, 'stub-image', 'b.png')
    expect(textOf(wrapper, 'stub-block-count')).toBe('0')
  })

  it('重跑 OCR 后上一次的图表与覆盖层一并作废', async () => {
    wrapper = mountPage()

    paste(window, imageFile('a.png'))
    await untilText(wrapper, 'stub-image', 'a.png')
    await wrapper.get('[data-testid="dev-pipeline-chart-run"]').trigger('click')
    await untilText(wrapper, 'stub-chart-count', '1')

    await wrapper.get('[data-testid="dev-pipeline-ocr-run"]').trigger('click')
    await untilText(wrapper, 'stub-block-count', '1')

    expect(textOf(wrapper, 'stub-chart-count')).toBe('0')
    expect(textOf(wrapper, 'stub-overlay-chart-count')).toBe('0')
  })

  it('样本库 404 的空态指向 dev 门禁，不说端点只在 dev server 注册', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) =>
        url === RENDER_SITE_DEV_ROUTES.samples
          ? new Response('<!DOCTYPE html><html>404</html>', { status: 404 })
          : payloadOf(url),
      ),
    )
    wrapper = mountPage()

    await vi.waitFor(() => {
      expect(textOf(wrapper, 'stub-samples-hint')).not.toBe('')
    })
    const hint = textOf(wrapper, 'stub-samples-hint')
    expect(hint).toContain('404')
    expect(hint).not.toContain('只在 dev server')
  })
})

/**
 * 图表这一步端点内部就含一次计费的翻译调用，故「谁触发的」比「结果对不对」更要紧：
 * 自动触发与失败重试都会把外部调用的量变成不可控，这类回归只能挂在组件上测。
 */
describe('dev/pipeline 的图表步骤与外部调用', () => {
  const pipelineCalls = (): number =>
    calls.filter((call) => call.url === RENDER_SITE_DEV_ROUTES.pipeline).length

  it('挂载后不自动装配：没有图也没人点按钮时一次都不打', async () => {
    wrapper = mountPage()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(pipelineCalls()).toBe(0)
  })

  it('点了才跑，且一次点击只打一次', async () => {
    wrapper = mountPage()
    paste(window, imageFile('a.png'))
    await untilText(wrapper, 'stub-image', 'a.png')

    await wrapper.get('[data-testid="dev-pipeline-chart-run"]').trigger('click')
    await untilText(wrapper, 'stub-chart-count', '1')

    expect(pipelineCalls()).toBe(1)
  })

  it('装配失败就停在失败上，不自动重试', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch((url) =>
        url === RENDER_SITE_DEV_ROUTES.pipeline
          ? new Response('{"error":"渲染站拒绝渲染"}', { status: 500 })
          : payloadOf(url),
      ),
    )
    wrapper = mountPage()
    paste(window, imageFile('a.png'))
    await untilText(wrapper, 'stub-image', 'a.png')

    await wrapper.get('[data-testid="dev-pipeline-chart-run"]').trigger('click')
    // 失败态没有可断言的计数变化，故直接等那一条调用落地再观察后续有没有再打。
    await vi.waitFor(() => {
      expect(pipelineCalls()).toBe(1)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(pipelineCalls()).toBe(1)
    expect(textOf(wrapper, 'stub-chart-count')).toBe('0')
  })

  /**
   * 端点要跑数秒，期间换图是常态：那时 setImage 已经作废了下游，若还无条件落地，
   * 上一张图的译文与版位会被压到新图上，坐标全错且没有提示——这是静默错位，只能挂组件测。
   */
  it('装配在途换了图，回来的结果属于上一张图：丢弃并提示，不写进状态', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      stubFetch(async (url) => {
        if (url === RENDER_SITE_DEV_ROUTES.pipeline) {
          await gate
        }
        return payloadOf(url)
      }),
    )
    wrapper = mountPage()
    paste(window, imageFile('a.png'))
    await untilText(wrapper, 'stub-image', 'a.png')

    await wrapper.get('[data-testid="dev-pipeline-chart-run"]').trigger('click')
    paste(window, imageFile('b.png'))
    await untilText(wrapper, 'stub-image', 'b.png')
    release()

    await untilText(wrapper, 'dev-pipeline-chart-notice', '结果属于上一张图，已丢弃')
    expect(textOf(wrapper, 'stub-chart-count')).toBe('0')
    expect(textOf(wrapper, 'stub-overlay-chart-count')).toBe('0')
    expect(pipelineCalls()).toBe(1)
  })

  it('清图后图表步骤回到禁用态，点不动也不再打端点', async () => {
    wrapper = mountPage()
    paste(window, imageFile('a.png'))
    await untilText(wrapper, 'stub-image', 'a.png')

    await wrapper.get('[data-testid="dev-pipeline-chart-run"]').trigger('click')
    await untilText(wrapper, 'stub-chart-count', '1')

    await wrapper.get('[data-testid="stub-clear"]').trigger('click')
    expect(textOf(wrapper, 'stub-chart-count')).toBe('0')
    expect(
      wrapper.get('[data-testid="dev-pipeline-chart-run"]').attributes('disabled'),
    ).toBeDefined()

    await wrapper.get('[data-testid="dev-pipeline-chart-run"]').trigger('click')
    expect(pipelineCalls()).toBe(1)
  })
})
