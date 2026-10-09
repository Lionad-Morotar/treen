import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

/**
 * settings.html 的界面面测试：把真实文件载进 jsdom（执行内联脚本），注入一个假的主进程桥，
 * 断言「读回的设置落到控件、控件的改动送回主进程」这条往返。
 *
 * 桌面程序刻意不带 lib.dom（见 mermaid/jsdom.d.ts 的理由），故这里用结构化最小接口描述用到的 DOM 面。
 */

interface ElementLike {
  checked: boolean
  textContent: string | null
  getAttribute(name: string): string | null
  addEventListener(type: string, listener: (event: { target: ElementLike }) => void): void
}

interface WindowLike {
  document: {
    getElementById(id: string): ElementLike | null
    addEventListener(type: string, listener: () => void): void
  }
  Event: new (type: string) => unknown
  treenSettings?: { get(): Promise<unknown>; set(patch: unknown): Promise<unknown> }
}

interface Bridge {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
}

const SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings.html')

function load(bridge?: Bridge): WindowLike {
  const html = readFileSync(SETTINGS_PATH, 'utf8')
  // 变量中转：本地 jsdom 声明只列了 pretendToBeVisual，这里额外开 runScripts 让内联脚本执行、
  // 用 beforeParse 在脚本运行前把桥注进去。
  const options = {
    runScripts: 'dangerously' as const,
    pretendToBeVisual: true,
    beforeParse: (window: unknown) => {
      if (bridge !== undefined) {
        ;(window as { treenSettings?: Bridge }).treenSettings = bridge
      }
    },
  }
  const dom = new JSDOM(html, options)
  return dom.window as unknown as WindowLike
}

function field(window: WindowLike, id: string): ElementLike {
  const element = window.document.getElementById(id)
  if (element === null) {
    throw new Error(`settings.html 缺少控件 #${id}`)
  }
  return element
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

async function settled(window: WindowLike): Promise<Bridge> {
  // 页面在 DOMContentLoaded 后自行 load 一次；等控件被回填即视为已就绪。
  const ok = await waitUntil(() => field(window, 'setting-translate-text').checked === true)
  expect(ok).toBe(true)
  return (window as unknown as { treenSettings: Bridge }).treenSettings
}

describe('settings.html 的读写往返', () => {
  it('打开时把主进程读回的设置落到控件上', async () => {
    const bridge = {
      get: vi.fn(async () => ({ translateText: false, translateCharts: true })),
      set: vi.fn(),
    }
    const window = load(bridge)

    // 图表开关在页面初始态是未勾选，只有 load 回填后才为 true——用它当就绪信号，
    // 否则「文本开关为 false」与初始态不可区分，断言会与加载赛跑。
    const applied = await waitUntil(() => field(window, 'setting-translate-charts').checked === true)
    expect(applied).toBe(true)
    expect(field(window, 'setting-translate-text').checked).toBe(false)
    expect(bridge.get).toHaveBeenCalled()
  })

  it('勾选即写回补丁，服务端返回的值回填控件并给出已保存提示', async () => {
    const bridge = {
      get: vi.fn(async () => ({ translateText: true, translateCharts: true })),
      set: vi.fn(async () => ({ translateText: true, translateCharts: false })),
    }
    const window = load(bridge)
    await settled(window)

    field(window, 'setting-translate-charts').checked = false
    dispatchChange(window, 'setting-translate-charts')

    const wrote = await waitUntil(() => bridge.set.mock.calls.length > 0)
    expect(wrote).toBe(true)
    expect(bridge.set).toHaveBeenCalledWith({ translateCharts: false })

    const saved = await waitUntil(() => field(window, 'settings-status').textContent === '已保存')
    expect(saved).toBe(true)
    expect(field(window, 'settings-status').getAttribute('data-kind')).toBe('ok')
  })

  it('写回失败时提示错误并把控件退回服务端真实状态', async () => {
    const bridge = {
      get: vi.fn(async () => ({ translateText: true, translateCharts: true })),
      set: vi.fn(async () => {
        throw new Error('IPC 断开')
      }),
    }
    const window = load(bridge)
    await settled(window)

    field(window, 'setting-translate-charts').checked = false
    dispatchChange(window, 'setting-translate-charts')

    const errored = await waitUntil(
      () => field(window, 'settings-status').getAttribute('data-kind') === 'error',
    )
    expect(errored).toBe(true)
    expect(field(window, 'settings-status').textContent).toContain('保存失败')
    // 退回真实状态：服务端仍是开，控件不该停在一个并未生效的关。
    const restored = await waitUntil(() => field(window, 'setting-translate-charts').checked === true)
    expect(restored).toBe(true)
  })

  it('桥缺失（页面被单独打开）时给出可见提示而不是静默', async () => {
    const window = load()

    const flagged = await waitUntil(
      () => field(window, 'settings-status').getAttribute('data-kind') === 'error',
    )
    expect(flagged).toBe(true)
    expect(field(window, 'settings-status').textContent).toContain('设置桥不可用')
  })
})

/** 派发一次 change 事件（jsdom 的 Event 类型经最小接口暴露）。 */
function dispatchChange(window: WindowLike, id: string): void {
  const element = window.document.getElementById(id)
  const target = element as unknown as { dispatchEvent(event: unknown): boolean }
  target.dispatchEvent(new window.Event('change'))
}
