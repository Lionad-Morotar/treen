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
  value: string
  textContent: string | null
  getAttribute(name: string): string | null
  addEventListener(type: string, listener: (event: { target: ElementLike }) => void): void
}

interface KeyEventInit {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

interface WindowLike {
  document: {
    getElementById(id: string): ElementLike | null
    addEventListener(type: string, listener: () => void): void
  }
  Event: new (type: string) => unknown
  KeyboardEvent: new (type: string, init?: KeyEventInit) => unknown
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

describe('settings.html 的冻结热键捕获', () => {
  const HOTKEY = 'setting-freeze-accelerator'

  function bridgeWith(accelerator: string) {
    return {
      get: vi.fn(async () => ({ freezeAccelerator: accelerator, translateText: true, translateCharts: true })),
      set: vi.fn(async (patch: unknown) => ({
        freezeAccelerator: accelerator,
        translateText: true,
        translateCharts: true,
        ...(patch as Record<string, unknown>),
      })),
    }
  }

  it('打开时把服务端的键位回填到热键框', async () => {
    const window = load(bridgeWith('Alt+T'))
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')
    expect(field(window, HOTKEY).value).toBe('Alt+T')
  })

  it('按下带修饰键的组合只写回 accelerator，不落成文本', async () => {
    const bridge = bridgeWith('Alt+T')
    const window = load(bridge)
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')

    dispatchKeydown(window, HOTKEY, { key: 'y', metaKey: true, shiftKey: true })

    const wrote = await waitUntil(() => bridge.set.mock.calls.length > 0)
    expect(wrote).toBe(true)
    expect(bridge.set).toHaveBeenCalledWith({ freezeAccelerator: 'Command+Shift+Y' })
  })

  it('缺主修饰键的组合不写回，并给出可见提示', async () => {
    const bridge = bridgeWith('Alt+T')
    const window = load(bridge)
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')

    // 只带 Shift 的键位一旦注册成全局热键，会在所有应用里截走这个键。
    dispatchKeydown(window, HOTKEY, { key: 'y', shiftKey: true })

    const flagged = await waitUntil(
      () => field(window, 'settings-status').getAttribute('data-kind') === 'error',
    )
    expect(flagged).toBe(true)
    expect(bridge.set).not.toHaveBeenCalled()
  })

  it('单独的 Escape 不写回（它是冻结态的退出键）', async () => {
    const bridge = bridgeWith('Alt+T')
    const window = load(bridge)
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')

    dispatchKeydown(window, HOTKEY, { key: 'Escape', metaKey: true })

    const flagged = await waitUntil(
      () => field(window, 'settings-status').getAttribute('data-kind') === 'error',
    )
    expect(flagged).toBe(true)
    expect(bridge.set).not.toHaveBeenCalled()
  })
})

/** 派发一次 keydown（jsdom 的 KeyboardEvent 类型经最小接口暴露）。 */
function dispatchKeydown(window: WindowLike, id: string, init: KeyEventInit): void {
  const element = window.document.getElementById(id)
  const target = element as unknown as { dispatchEvent(event: unknown): boolean }
  target.dispatchEvent(new window.KeyboardEvent('keydown', init))
}

/** 派发一次 change 事件（jsdom 的 Event 类型经最小接口暴露）。 */
function dispatchChange(window: WindowLike, id: string): void {
  const element = window.document.getElementById(id)
  const target = element as unknown as { dispatchEvent(event: unknown): boolean }
  target.dispatchEvent(new window.Event('change'))
}
