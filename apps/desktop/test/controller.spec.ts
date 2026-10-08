import { describe, expect, it, vi } from 'vitest'
import {
  createFreezeController,
  type FreezeFrame,
  type OverlayWindowHandle,
  type SelectionSource,
} from '../src/freeze/controller'
import { ShortcutManager, type ShortcutRegistrar } from '../src/freeze/shortcuts'
import type { DisplayLike } from '../src/freeze/geometry'
import type { Candidate } from '../src/highlight/candidates'

const primary: DisplayLike = {
  id: 1,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 100, height: 80 },
}
const secondary: DisplayLike = {
  id: 2,
  scaleFactor: 1,
  bounds: { x: -120, y: 0, width: 120, height: 90 },
}
const TRIGGER = 'CommandOrControl+Shift+X'
const ESCAPE = 'Escape'
const COPY = 'CommandOrControl+C'
const TRANSLATE = 'CommandOrControl+T'

function fakeShortcuts(accept: (accelerator: string) => boolean = () => true) {
  const handlers = new Map<string, () => void>()
  const registrar: ShortcutRegistrar = {
    register: (accelerator, handler) => {
      if (!accept(accelerator) || handlers.has(accelerator)) {
        return false
      }
      handlers.set(accelerator, handler)
      return true
    },
    unregister: (accelerator) => handlers.delete(accelerator),
    isRegistered: (accelerator) => handlers.has(accelerator),
  }
  return { manager: new ShortcutManager(registrar), handlers }
}

interface WindowRecord {
  handle: OverlayWindowHandle
  display: DisplayLike
  frame: FreezeFrame
}

function fakeWindows(failOnDisplayId?: number) {
  const records: WindowRecord[] = []
  const destroyed = new Set<number>()
  let seq = 0
  const factory = {
    create(display: DisplayLike, frame: FreezeFrame): OverlayWindowHandle {
      if (display.id === failOnDisplayId) {
        throw new Error(`模拟建窗失败：display ${display.id}`)
      }
      const id = ++seq
      const handle: OverlayWindowHandle = {
        id,
        displayId: display.id,
        focus: vi.fn(),
        close: vi.fn(() => {
          destroyed.add(id)
        }),
        isDestroyed: () => destroyed.has(id),
        setCandidates: vi.fn(),
        readSelection: async (): Promise<SelectionSource> => ({
          display,
          frame,
          locked: null,
        }),
      }
      records.push({ handle, display, frame })
      return handle
    },
  }
  return { factory, records }
}

function frameFor(display: DisplayLike): FreezeFrame {
  return {
    id: `src-${display.id}`,
    displayId: String(display.id),
    size: { width: 10, height: 10 },
    dataUrl: `data:image/png;base64,${display.id}`,
  }
}

interface HarnessOptions {
  displays?: DisplayLike[]
  frames?: FreezeFrame[]
  pointer?: { x: number; y: number }
  failOnDisplayId?: number
  acceptAccelerator?: (accelerator: string) => boolean
  capture?: () => Promise<FreezeFrame[]>
  buildCandidates?: (display: DisplayLike, frame: FreezeFrame) => Promise<readonly Candidate[]>
  copySelection?: () => unknown
  translateSelection?: () => unknown
}

function createHarness(options: HarnessOptions = {}) {
  const displays = options.displays ?? [primary, secondary]
  const shortcuts = fakeShortcuts(options.acceptAccelerator)
  const windows = fakeWindows(options.failOnDisplayId)
  const captureFrames = vi.fn(options.capture ?? (async () => options.frames ?? displays.map(frameFor)))
  const warn = vi.fn()
  const info = vi.fn()
  const error = vi.fn()
  const reportError = vi.fn()
  const controller = createFreezeController({
    listDisplays: () => displays,
    captureFrames,
    windows: windows.factory,
    shortcuts: shortcuts.manager,
    triggerAccelerator: TRIGGER,
    exitAccelerator: ESCAPE,
    copyAccelerator: COPY,
    copySelection: options.copySelection,
    translateAccelerator: TRANSLATE,
    translateSelection: options.translateSelection,
    pointOfInterest: () => options.pointer ?? { x: 10, y: 10 },
    buildCandidates: options.buildCandidates,
    reportError,
    logger: { warn, info, error },
  })
  return { controller, shortcuts, windows, captureFrames, warn, info, error, reportError, displays }
}

describe('freeze controller: start', () => {
  it('registers the trigger accelerator and enters freeze when it fires', async () => {
    const harness = createHarness()

    expect(harness.controller.start()).toBe(true)
    expect(harness.shortcuts.handlers.has(TRIGGER)).toBe(true)

    harness.shortcuts.handlers.get(TRIGGER)?.()

    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(true))
    expect(harness.windows.records).toHaveLength(2)
  })
})

describe('freeze controller: 重复触发热键', () => {
  async function frozenHarness() {
    const harness = createHarness()
    harness.controller.start()
    harness.shortcuts.handlers.get(TRIGGER)?.()
    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(true))
    return harness
  }

  it('再按一次触发热键就退出冻结，与 Escape 同义', async () => {
    const harness = await frozenHarness()

    harness.shortcuts.handlers.get(TRIGGER)?.()

    expect(harness.controller.isFrozen()).toBe(false)
    expect(harness.windows.records.every((r) => r.handle.isDestroyed())).toBe(true)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(false)
  })

  it('退出不重新截屏，热键是开关而不是重新进入', async () => {
    const harness = await frozenHarness()

    harness.shortcuts.handlers.get(TRIGGER)?.()

    expect(harness.captureFrames).toHaveBeenCalledTimes(1)
    expect(harness.windows.records).toHaveLength(2)
  })

  it('退出后可以再次进入', async () => {
    const harness = await frozenHarness()

    harness.shortcuts.handlers.get(TRIGGER)?.()
    harness.shortcuts.handlers.get(TRIGGER)?.()

    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(true))
    expect(harness.captureFrames).toHaveBeenCalledTimes(2)
  })

  it('重复触发退出时一并释放拷贝键', async () => {
    const harness = createHarness({ copySelection: vi.fn() })
    harness.controller.start()
    harness.shortcuts.handlers.get(TRIGGER)?.()
    await vi.waitFor(() => expect(harness.shortcuts.handlers.has(COPY)).toBe(true))

    harness.shortcuts.handlers.get(TRIGGER)?.()

    expect(harness.shortcuts.handlers.size).toBe(1)
    expect(harness.shortcuts.handlers.has(TRIGGER)).toBe(true)
  })
})

describe('freeze controller: enter', () => {
  it('captures at the largest physical size and opens one window per matched display', async () => {
    const harness = createHarness()

    await harness.controller.enter()

    expect(harness.captureFrames).toHaveBeenCalledWith({ width: 200, height: 160 })
    expect(harness.windows.records.map((r) => r.display.id)).toEqual([1, 2])
    expect(harness.windows.records[0]?.frame.dataUrl).toBe('data:image/png;base64,1')
    expect(harness.controller.isFrozen()).toBe(true)
  })

  it('registers Escape to leave freeze', async () => {
    const harness = createHarness()

    await harness.controller.enter()
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(true)

    harness.shortcuts.handlers.get(ESCAPE)?.()

    expect(harness.controller.isFrozen()).toBe(false)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(false)
    expect(harness.windows.records.every((r) => r.handle.isDestroyed())).toBe(true)
  })

  it('is idempotent while a freeze is already in flight', async () => {
    const harness = createHarness()

    await Promise.all([harness.controller.enter(), harness.controller.enter()])

    expect(harness.captureFrames).toHaveBeenCalledTimes(1)
    expect(harness.windows.records).toHaveLength(2)
  })

  it('focuses the window on the display under the pointer', async () => {
    const harness = createHarness({ pointer: { x: -60, y: 10 } })

    await harness.controller.enter()

    const secondaryWindow = harness.windows.records.find((r) => r.display.id === 2)
    expect(secondaryWindow?.handle.focus).toHaveBeenCalledTimes(1)
  })

  it('skips displays without a matching capture and reports them', async () => {
    const harness = createHarness({ frames: [frameFor(primary)] })

    await harness.controller.enter()

    expect(harness.windows.records.map((r) => r.display.id)).toEqual([1])
    expect(harness.warn).toHaveBeenCalled()
  })

  it('rejects and leaves no shortcut behind when there are no displays', async () => {
    const harness = createHarness({ displays: [], frames: [] })

    await expect(harness.controller.enter()).rejects.toThrow(/显示器/)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(false)
    expect(harness.controller.isFrozen()).toBe(false)
  })

  it('closes partially created windows and releases Escape when window creation fails', async () => {
    const harness = createHarness({ failOnDisplayId: 2 })

    await expect(harness.controller.enter()).rejects.toThrow(/建窗失败/)

    expect(harness.windows.records).toHaveLength(1)
    expect(harness.windows.records[0]?.handle.isDestroyed()).toBe(true)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(false)
    expect(harness.controller.isFrozen()).toBe(false)
  })
})

describe('freeze controller: exit', () => {
  it('closes every window and unregisters Escape', async () => {
    const harness = createHarness()
    await harness.controller.enter()

    harness.controller.exit()

    expect(harness.controller.isFrozen()).toBe(false)
    expect(harness.windows.records.every((r) => r.handle.isDestroyed())).toBe(true)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(false)
  })

  it('is a no-op when nothing is frozen', () => {
    const harness = createHarness()

    expect(() => harness.controller.exit()).not.toThrow()
    expect(harness.controller.isFrozen()).toBe(false)
  })
})

describe('freeze controller: 失败与中断路径', () => {
  it('refuses to freeze when the exit accelerator cannot be registered', async () => {
    const harness = createHarness({ acceptAccelerator: (accelerator) => accelerator !== ESCAPE })

    await expect(harness.controller.enter()).rejects.toThrow(/退出键/)
    expect(harness.windows.records).toEqual([])
    expect(harness.controller.isFrozen()).toBe(false)
    expect(harness.shortcuts.handlers.size).toBe(0)
  })

  it('surfaces capture failures to the user instead of failing silently', async () => {
    const harness = createHarness({
      capture: async () => {
        throw new Error('截屏失败：未授予屏幕录制权限')
      },
    })

    await expect(harness.controller.enter()).rejects.toThrow(/屏幕录制权限/)
    expect(harness.reportError).toHaveBeenCalledWith('截屏失败：未授予屏幕录制权限')
    expect(harness.error).toHaveBeenCalled()
    expect(harness.windows.records).toEqual([])
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(false)
  })

  it('reports failures raised through the trigger hotkey without an unhandled rejection', async () => {
    const harness = createHarness({
      capture: async () => {
        throw new Error('截屏失败：无法枚举屏幕源')
      },
    })
    harness.controller.start()

    harness.shortcuts.handlers.get(TRIGGER)?.()

    await vi.waitFor(() => expect(harness.reportError).toHaveBeenCalledTimes(1))
    expect(harness.controller.isFrozen()).toBe(false)
  })

  it('abandons an in-flight freeze when disposed, leaving no overlay or shortcut behind', async () => {
    let releaseCapture: (frames: FreezeFrame[]) => void = () => {}
    const harness = createHarness({
      capture: () =>
        new Promise<FreezeFrame[]>((resolve) => {
          releaseCapture = resolve
        }),
    })

    const pending = harness.controller.enter()
    harness.controller.dispose()
    releaseCapture([frameFor(primary), frameFor(secondary)])
    await pending

    expect(harness.windows.records).toEqual([])
    expect(harness.controller.isFrozen()).toBe(false)
    expect(harness.shortcuts.handlers.size).toBe(0)
  })

  it('ignores enter after dispose', async () => {
    const harness = createHarness()
    harness.controller.dispose()

    await harness.controller.enter()

    expect(harness.captureFrames).not.toHaveBeenCalled()
    expect(harness.controller.isFrozen()).toBe(false)
  })
})

describe('freeze controller: 候选区域注入', () => {
  function injected(record: WindowRecord | undefined): readonly Candidate[] | undefined {
    if (record === undefined) {
      return undefined
    }
    return vi.mocked(record.handle.setCandidates).mock.calls[0]?.[0]
  }

  it('把每块屏的候选区域送进该屏自己的覆盖窗', async () => {
    const harness = createHarness({
      buildCandidates: async (display) => [
        { x: 1, y: 2, width: display.id, height: 3, source: 'edge' },
      ],
    })

    await harness.controller.enter()
    await vi.waitFor(() =>
      expect(
        harness.windows.records.every((r) => vi.mocked(r.handle.setCandidates).mock.calls.length === 1),
      ).toBe(true),
    )

    expect(injected(harness.windows.records[0])).toEqual([
      { x: 1, y: 2, width: 1, height: 3, source: 'edge' },
    ])
    expect(injected(harness.windows.records[1])).toEqual([
      { x: 1, y: 2, width: 2, height: 3, source: 'edge' },
    ])
  })

  it('候选区域计算失败只记日志，已经进入的冻结态与出口都不受影响', async () => {
    const harness = createHarness({
      buildCandidates: async () => {
        throw new Error('边缘检测炸了')
      },
    })

    await harness.controller.enter()
    await vi.waitFor(() => expect(harness.warn).toHaveBeenCalled())
    expect(harness.controller.isFrozen()).toBe(true)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(true)
    expect(harness.windows.records.every((r) => !r.handle.isDestroyed())).toBe(true)
    expect(harness.warn.mock.calls.some(([message]) => String(message).includes('边缘检测炸了'))).toBe(true)
  })

  it('依赖是同步抛错的非 async 实现时也只在日志里落地，不拆掉冻结', async () => {
    // 返回值类型是 Promise 只是约定，const 一个同步抛错的函数同样满足签名。
    // 直接 void build(...) 会让异常穿出 enter 的 catch，把已经铺好的画面整个拆掉。
    const harness = createHarness({
      buildCandidates: () => {
        throw new Error('同步炸了')
      },
    })

    await harness.controller.enter()
    await vi.waitFor(() => expect(harness.warn).toHaveBeenCalled())

    expect(harness.controller.isFrozen()).toBe(true)
    expect(harness.windows.records.every((r) => !r.handle.isDestroyed())).toBe(true)
    expect(harness.warn.mock.calls.some(([message]) => String(message).includes('同步炸了'))).toBe(true)
  })

  it('缺省不注入候选，冻结只铺画面', async () => {
    const harness = createHarness()

    await harness.controller.enter()

    expect(
      harness.windows.records.every((r) => vi.mocked(r.handle.setCandidates).mock.calls.length === 0),
    ).toBe(true)
  })
})

describe('freeze controller: 冻结期拷贝键', () => {
  it('冻结期间注册拷贝键，退出时释放', async () => {
    const harness = createHarness({ copySelection: vi.fn() })

    await harness.controller.enter()
    expect(harness.shortcuts.handlers.has(COPY)).toBe(true)

    harness.controller.exit()

    expect(harness.shortcuts.handlers.has(COPY)).toBe(false)
  })

  it('缺省不给拷贝键，冻结仍然成立', async () => {
    const harness = createHarness()

    await harness.controller.enter()

    expect(harness.shortcuts.handlers.has(COPY)).toBe(false)
    expect(harness.controller.isFrozen()).toBe(true)
  })

  it('拷贝键注册失败只记日志，不进冻结失败路径', async () => {
    const harness = createHarness({
      copySelection: vi.fn(),
      acceptAccelerator: (accelerator) => accelerator !== COPY,
    })

    await harness.controller.enter()

    expect(harness.controller.isFrozen()).toBe(true)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(true)
    expect(harness.warn.mock.calls.some(([message]) => String(message).includes(COPY))).toBe(true)
  })

  it('按拷贝键把动作交给注入的拷贝实现', async () => {
    const copySelection = vi.fn()
    const harness = createHarness({ copySelection })

    await harness.controller.enter()
    harness.shortcuts.handlers.get(COPY)?.()

    await vi.waitFor(() => expect(copySelection).toHaveBeenCalledTimes(1))
  })

  it('拷贝实现异步失败时收进日志，不产生未处理拒绝', async () => {
    const harness = createHarness({
      copySelection: async () => {
        throw new Error('剪贴板写入失败')
      },
    })

    await harness.controller.enter()
    harness.shortcuts.handlers.get(COPY)?.()

    await vi.waitFor(() =>
      expect(harness.warn.mock.calls.some(([message]) => String(message).includes('剪贴板写入失败'))).toBe(
        true,
      ),
    )
  })

  it('拷贝实现同步抛错时同样只落日志', async () => {
    const harness = createHarness({
      copySelection: () => {
        throw new Error('同步炸了')
      },
    })

    await harness.controller.enter()
    harness.shortcuts.handlers.get(COPY)?.()

    await vi.waitFor(() =>
      expect(harness.warn.mock.calls.some(([message]) => String(message).includes('同步炸了'))).toBe(true),
    )
    expect(harness.controller.isFrozen()).toBe(true)
  })

  it('冻结失败时不留下拷贝键', async () => {
    const harness = createHarness({ copySelection: vi.fn(), failOnDisplayId: 2 })

    await expect(harness.controller.enter()).rejects.toThrow(/建窗失败/)

    expect(harness.shortcuts.handlers.has(COPY)).toBe(false)
  })
})

describe('freeze controller: 冻结期翻译键', () => {
  it('冻结期间注册翻译键，退出时释放', async () => {
    const harness = createHarness({ translateSelection: vi.fn() })

    await harness.controller.enter()
    expect(harness.shortcuts.handlers.has(TRANSLATE)).toBe(true)

    harness.controller.exit()

    expect(harness.shortcuts.handlers.has(TRANSLATE)).toBe(false)
  })

  it('缺省不给翻译键，冻结仍然成立', async () => {
    const harness = createHarness()

    await harness.controller.enter()

    expect(harness.shortcuts.handlers.has(TRANSLATE)).toBe(false)
    expect(harness.controller.isFrozen()).toBe(true)
  })

  it('翻译键注册失败只记日志，不进冻结失败路径', async () => {
    const harness = createHarness({
      translateSelection: vi.fn(),
      acceptAccelerator: (accelerator) => accelerator !== TRANSLATE,
    })

    await harness.controller.enter()

    expect(harness.controller.isFrozen()).toBe(true)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(true)
    expect(harness.warn.mock.calls.some(([message]) => String(message).includes(TRANSLATE))).toBe(true)
  })

  it('按翻译键把动作交给注入的实现，异步失败收进日志且不拆掉冻结', async () => {
    const translateSelection = vi.fn(async () => {
      throw new Error('翻译链路炸了')
    })
    const harness = createHarness({ translateSelection })

    await harness.controller.enter()
    harness.shortcuts.handlers.get(TRANSLATE)?.()

    await vi.waitFor(() => expect(translateSelection).toHaveBeenCalledTimes(1))
    await vi.waitFor(() =>
      expect(harness.warn.mock.calls.some(([message]) => String(message).includes('翻译链路炸了'))).toBe(true),
    )
    expect(harness.controller.isFrozen()).toBe(true)
  })

  it('拷贝键与翻译键可并存，退出时一并释放', async () => {
    const harness = createHarness({ copySelection: vi.fn(), translateSelection: vi.fn() })

    await harness.controller.enter()
    expect(harness.shortcuts.handlers.has(COPY)).toBe(true)
    expect(harness.shortcuts.handlers.has(TRANSLATE)).toBe(true)

    harness.controller.exit()

    expect(harness.shortcuts.handlers.size).toBe(0)
  })
})

describe('freeze controller: dispose', () => {
  it('releases every shortcut and tears down the overlay', async () => {
    const harness = createHarness()
    harness.controller.start()
    await harness.controller.enter()

    harness.controller.dispose()

    expect(harness.shortcuts.handlers.size).toBe(0)
    expect(harness.controller.isFrozen()).toBe(false)
    expect(harness.windows.records.every((r) => r.handle.isDestroyed())).toBe(true)
  })
})
