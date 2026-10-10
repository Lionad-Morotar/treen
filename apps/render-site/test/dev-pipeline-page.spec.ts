// @vitest-environment jsdom
import { defineComponent, h, type PropType } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { RENDER_SITE_DEV_ROUTES, RENDER_SITE_ROUTES } from '@treen/ipc/routes'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DevPipelinePage from '../app/pages/dev/pipeline.vue'
import type { EditableBlock, TranslationPair } from '../app/utils/dev-pipeline-format'

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
  return {}
}

/** 替掉 fetch：既给可断言的调用记录，也免得单测真去打计费的外部翻译 API。 */
function stubFetch(respond: (url: string) => unknown) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    calls.push({
      url,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    })
    const result = respond(url)
    if (result instanceof Response) {
      return result
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/** 造一个 PNG：页面只按 type 与扩展名收图、不解码像素，故一个签名头足够走完收图链路。 */
function imageFile(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, {
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
    global: { components: { DevPanel, DevImageSource, DevOcrStep, DevTranslateStep } },
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
