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
  hidden: boolean
  getAttribute(name: string): string | null
  addEventListener(type: string, listener: (event: { target: ElementLike }) => void): void
}

interface KeyEventInit {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
}

interface WindowLike {
  document: {
    getElementById(id: string): ElementLike | null
    addEventListener(type: string, listener: () => void): void
  }
  Event: new (type: string) => unknown
  KeyboardEvent: new (type: string, init?: KeyEventInit) => unknown
  treenSettings?: { get(): Promise<unknown>; set(patch: unknown): Promise<unknown> }
  treenHotkeyCapture?: CaptureBridge
}

interface Bridge {
  get: ReturnType<typeof vi.fn>
  set: ReturnType<typeof vi.fn>
}

/** 热键 capture 桥的最小面（与 settings-preload.cjs 暴露的一致）。 */
interface CaptureBridge {
  status(): Promise<{ active: boolean; authorized: boolean }>
  openSystemSettings(): Promise<unknown>
}

const SETTINGS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'settings.html')

function load(bridge?: Bridge, captureBridge?: CaptureBridge): WindowLike {
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
      if (captureBridge !== undefined) {
        ;(window as { treenHotkeyCapture?: CaptureBridge }).treenHotkeyCapture = captureBridge
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

  it('图内文案开关：读回的值落到控件、勾选改动写回补丁', async () => {
    const bridge = {
      get: vi.fn(async () => ({ translateText: true, translateCharts: true, translateNodeLabels: false })),
      set: vi.fn(async (patch: unknown) => ({
        translateText: true,
        translateCharts: true,
        translateNodeLabels: true,
        ...(patch as Record<string, unknown>),
      })),
    }
    const window = load(bridge)

    // 服务端是关：页面初始态未勾选，回填后仍应为关（与加载赛跑用已勾选的其他开关当就绪信号）。
    const applied = await waitUntil(() => field(window, 'setting-translate-text').checked === true)
    expect(applied).toBe(true)
    expect(field(window, 'setting-translate-node-labels').checked).toBe(false)

    field(window, 'setting-translate-node-labels').checked = true
    dispatchChange(window, 'setting-translate-node-labels')

    const wrote = await waitUntil(() => bridge.set.mock.calls.length > 0)
    expect(wrote).toBe(true)
    expect(bridge.set).toHaveBeenCalledWith({ translateNodeLabels: true })

    const saved = await waitUntil(() => field(window, 'settings-status').textContent === '已保存')
    expect(saved).toBe(true)
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

  it('只按下修饰键是输入过程中的常态，既不写回也不报错', async () => {
    const bridge = bridgeWith('Alt+T')
    const window = load(bridge)
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')

    dispatchKeydown(window, HOTKEY, { key: 'Meta', metaKey: true })
    dispatchKeydown(window, HOTKEY, { key: 'Shift', shiftKey: true })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(bridge.set).not.toHaveBeenCalled()
    expect(field(window, 'settings-status').getAttribute('data-kind')).not.toBe('error')
  })

  it('空格与加号翻成 accelerator 认得的键名', async () => {
    const bridge = bridgeWith('Alt+T')
    const window = load(bridge)
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')

    dispatchKeydown(window, HOTKEY, { key: ' ', metaKey: true })
    const spaced = await waitUntil(() => bridge.set.mock.calls.length > 0)
    expect(spaced).toBe(true)
    expect(bridge.set).toHaveBeenCalledWith({ freezeAccelerator: 'Command+Space' })

    dispatchKeydown(window, HOTKEY, { key: '+', metaKey: true })
    await waitUntil(() => bridge.set.mock.calls.length > 1)
    expect(bridge.set).toHaveBeenLastCalledWith({ freezeAccelerator: 'Command+Plus' })
  })

  it('按住不放的键盘重复不反复落盘', async () => {
    const bridge = bridgeWith('Alt+T')
    const window = load(bridge)
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')

    dispatchKeydown(window, HOTKEY, { key: 'k', metaKey: true })
    await waitUntil(() => bridge.set.mock.calls.length === 1)
    dispatchKeydown(window, HOTKEY, { key: 'k', metaKey: true, repeat: true })
    dispatchKeydown(window, HOTKEY, { key: 'k', metaKey: true, repeat: true })

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(bridge.set).toHaveBeenCalledTimes(1)
  })

  it('死键字符（Option+Shift 组合的 event.key）不写回，并给出可见提示', async () => {
    const bridge = bridgeWith('Alt+T')
    const window = load(bridge)
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')

    // macOS 上 Option+Shift+字母 的 event.key 是「˛」一类的死键字符；Electron 解析不了
    // 拼出的 accelerator 且注册/注销它时抛异常，放行会在退出时主进程崩窗。
    dispatchKeydown(window, HOTKEY, { key: '˛', altKey: true, shiftKey: true })

    const flagged = await waitUntil(
      () => field(window, 'settings-status').getAttribute('data-kind') === 'error',
    )
    expect(flagged).toBe(true)
    expect(bridge.set).not.toHaveBeenCalled()
  })

  it('Dead 键名不写回', async () => {
    const bridge = bridgeWith('Alt+T')
    const window = load(bridge)
    await waitUntil(() => field(window, HOTKEY).value === 'Alt+T')

    dispatchKeydown(window, HOTKEY, { key: 'Dead', altKey: true })

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

describe('settings.html 的按键捕获状态区', () => {
  const HINT = 'hotkey-capture-hint'
  const GRANT = 'hotkey-capture-grant'

  function captureBridgeWith(state: { ready?: boolean; active: boolean; authorized: boolean }) {
    return {
      status: vi.fn(async () => ({ ready: true, ...state })),
      openSystemSettings: vi.fn(async () => undefined),
    }
  }

  function settingsBridge(): Bridge {
    return {
      get: vi.fn(async () => ({ translateText: true, translateCharts: true })),
      set: vi.fn(async () => ({ translateText: true, translateCharts: true })),
    }
  }

  it('capture 生效时说明吞键已接管，不给授权按钮', async () => {
    const captureBridge = captureBridgeWith({ active: true, authorized: true })
    const window = load(settingsBridge(), captureBridge)
    await waitUntil(() => field(window, HINT).textContent?.includes('已捕获') === true)
    expect(field(window, GRANT).hidden).toBe(true)
  })

  it('未授权时显示监听模式说明并给出授权入口', async () => {
    const captureBridge = captureBridgeWith({ active: false, authorized: false })
    const window = load(settingsBridge(), captureBridge)
    await waitUntil(() => field(window, HINT).textContent?.includes('监听模式') === true)
    expect(field(window, GRANT).hidden).toBe(false)

    const target = field(window, GRANT) as unknown as { click(): void }
    target.click()
    const opened = await waitUntil(() => captureBridge.openSystemSettings.mock.calls.length > 0)
    expect(opened).toBe(true)
  })

  it('授权但通道失效（助手回落）时也按监听模式提示', async () => {
    const captureBridge = captureBridgeWith({ active: false, authorized: true })
    const window = load(settingsBridge(), captureBridge)
    await waitUntil(() => field(window, HINT).textContent?.includes('助手异常') === true)
    expect(field(window, GRANT).hidden).toBe(true)
  })

  it('capture 桥缺失时不阻塞设置页主功能，状态行给提示', async () => {
    const window = load(settingsBridge())
    // 设置主功能照常：读回值仍落到控件。
    const applied = await waitUntil(() => field(window, 'setting-translate-charts').checked === true)
    expect(applied).toBe(true)
    await waitUntil(() => field(window, HINT).textContent?.includes('监听模式') === true)
  })

  it('主进程 probe 未完成（ready=false）时保持检查中，就绪后重查并更新', async () => {
    const captureBridge = captureBridgeWith({ ready: false, active: false, authorized: false })
    const window = load(settingsBridge(), captureBridge)
    // 就绪前的查询不切文案（避免把未授权误报给已授权机器），保持「检查中」。
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(field(window, HINT).textContent).toBe('检查中…')
    // 就绪后重查落定最终态。
    captureBridge.status.mockResolvedValue({ ready: true, active: false, authorized: false })
    const settled = await waitUntil(() => field(window, HINT).textContent?.includes('监听模式') === true)
    expect(settled).toBe(true)
    expect(field(window, GRANT).hidden).toBe(false)
  })
})
