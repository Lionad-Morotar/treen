import { describe, expect, it, vi } from 'vitest'
import {
  createFreezeController,
  type FreezeFrame,
  type LockPollTimers,
  type OverlayWindowHandle,
  type RegionLockTarget,
  type SelectionSource,
} from '../src/freeze/controller'
import { ShortcutManager, type ShortcutRegistrar } from '../src/freeze/shortcuts'
import type { DisplayLike, Rect } from '../src/freeze/geometry'
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
const COMPOSITE = 'CommandOrControl+Shift+C'
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
  /** 该屏当前锁定的选区；测试直接改它来模拟用户在渲染层点了某块区域 */
  locked: Rect | null
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
      const record = {
        display,
        frame,
        locked: null as Rect | null,
        handle: undefined as unknown as OverlayWindowHandle,
      }
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
          locked: record.locked,
        }),
        readLocked: vi.fn(async () => record.locked),
        setOverlay: vi.fn(),
        setLoading: vi.fn(),
        clearLoading: vi.fn(),
        captureComposite: vi.fn(async () => null),
      }
      record.handle = handle
      records.push(record)
      return handle
    },
  }
  return { factory, records }
}

/** 确定性定时器：控制器只在测试显式 tick 时轮询，不依赖真实时钟。 */
function manualTimers() {
  const slots: { active: boolean; handler: () => void }[] = []
  const timers: LockPollTimers = {
    setInterval: (handler) => {
      slots.push({ active: true, handler })
      return slots.length - 1
    },
    clearInterval: (handle) => {
      const slot = slots[handle as number]
      if (slot !== undefined) {
        slot.active = false
      }
    },
  }
  return {
    timers,
    tick: () => {
      for (const slot of slots) {
        if (slot.active) {
          slot.handler()
        }
      }
    },
    intervalCount: () => slots.length,
    activeCount: () => slots.filter((slot) => slot.active).length,
  }
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
  /** 拷贝动作的 trigger 本体；harness 把它包成 FreezeAction 并记录 invalidate 调用 */
  copySelection?: () => unknown
  copyComposite?: () => unknown
  /** 区域翻译动作的 trigger 本体；harness 同样包成 RegionTranslateAction 并记录 invalidate 调用 */
  onRegionLocked?: (target: RegionLockTarget) => unknown
  timers?: LockPollTimers
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
  /** 各拷贝动作的 invalidate 被调记录；键是动作名。退出作废语义由它断言。 */
  const invalidated: string[] = []
  const asAction = (name: string, trigger?: () => unknown) =>
    trigger === undefined ? undefined : { trigger, invalidate: () => invalidated.push(name) }
  const controller = createFreezeController({
    listDisplays: () => displays,
    captureFrames,
    windows: windows.factory,
    shortcuts: shortcuts.manager,
    triggerAccelerator: TRIGGER,
    exitAccelerator: ESCAPE,
    copyAccelerator: COPY,
    copySelection: asAction('copySelection', options.copySelection),
    copyComposite: asAction('copyComposite', options.copyComposite),
    onRegionLocked:
      options.onRegionLocked === undefined
        ? undefined
        : {
            trigger: options.onRegionLocked,
            invalidate: () => invalidated.push('onRegionLocked'),
          },
    timers: options.timers,
    pointOfInterest: () => options.pointer ?? { x: 10, y: 10 },
    buildCandidates: options.buildCandidates,
    reportError,
    logger: { warn, info, error },
  })
  return {
    controller,
    shortcuts,
    windows,
    captureFrames,
    warn,
    info,
    error,
    reportError,
    displays,
    invalidated,
  }
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

describe('freeze controller: 改触发热键', () => {
  const NEXT = 'Alt+T'

  it('换键后旧键释放、新键接手，按新键能进入冻结', async () => {
    const harness = createHarness()
    harness.controller.start()

    expect(harness.controller.applyTriggerAccelerator(NEXT)).toBe(true)
    expect(harness.shortcuts.handlers.has(TRIGGER)).toBe(false)
    expect(harness.shortcuts.handlers.has(NEXT)).toBe(true)

    harness.shortcuts.handlers.get(NEXT)?.()
    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(true))
  })

  it('新键被别的应用占着时保留旧键，不让改一次键反而丢了原来的热键', async () => {
    const harness = createHarness({ acceptAccelerator: (accelerator) => accelerator !== NEXT })
    harness.controller.start()

    expect(harness.controller.applyTriggerAccelerator(NEXT)).toBe(false)
    expect(harness.shortcuts.handlers.has(TRIGGER)).toBe(true)
    expect(harness.shortcuts.handlers.has(NEXT)).toBe(false)

    harness.shortcuts.handlers.get(TRIGGER)?.()
    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(true))
  })

  it('新键与当前键相同时不做无谓的释放重注册，直接回报现状', () => {
    const harness = createHarness()
    harness.controller.start()

    expect(harness.controller.applyTriggerAccelerator(TRIGGER)).toBe(true)
    expect(harness.shortcuts.handlers.has(TRIGGER)).toBe(true)
  })

  it('换键之后旧键不再能触发冻结', async () => {
    const harness = createHarness()
    harness.controller.start()
    harness.controller.applyTriggerAccelerator(NEXT)

    harness.shortcuts.handlers.get(TRIGGER)?.()

    expect(harness.controller.isFrozen()).toBe(false)
  })

  it('dispose 之后不再改键，也不把已释放的键装回来', () => {
    const harness = createHarness()
    harness.controller.start()
    harness.controller.dispose()

    expect(harness.controller.applyTriggerAccelerator(NEXT)).toBe(false)
    expect(harness.shortcuts.handlers.has(NEXT)).toBe(false)
    expect(harness.shortcuts.handlers.has(TRIGGER)).toBe(false)
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

  it('退出冻结时作废两类拷贝与翻译的全部在途轮，dispose 经 exit 同样生效', async () => {
    const withBoth = createHarness({
      copySelection: vi.fn(),
      copyComposite: vi.fn(),
      onRegionLocked: vi.fn(),
    })

    await withBoth.controller.enter()
    withBoth.controller.exit()

    expect(withBoth.invalidated).toEqual(['copySelection', 'copyComposite', 'onRegionLocked'])

    // dispose 是应用退出路径，同样要作废（它内部走的就是 exit，这里钉住不回退）。
    const disposed = createHarness({
      copySelection: vi.fn(),
      copyComposite: vi.fn(),
      onRegionLocked: vi.fn(),
    })
    await disposed.controller.enter()
    disposed.controller.dispose()

    expect(disposed.invalidated).toEqual(['copySelection', 'copyComposite', 'onRegionLocked'])
  })

  it('未冻结时 exit 不触发作废：没有在途轮就没有可作废的东西', async () => {
    const harness = createHarness({ copySelection: vi.fn(), copyComposite: vi.fn(), onRegionLocked: vi.fn() })

    harness.controller.exit()

    expect(harness.invalidated).toEqual([])
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

describe('freeze controller: 冻结期合成拷贝键', () => {
  it('冻结期间注册合成键，退出时释放', async () => {
    const harness = createHarness({ copyComposite: vi.fn() })

    await harness.controller.enter()
    expect(harness.shortcuts.handlers.has(COMPOSITE)).toBe(true)

    harness.controller.exit()
    expect(harness.shortcuts.handlers.has(COMPOSITE)).toBe(false)
  })

  it('两个拷贝键各管各的：按合成键不触发原始截图拷贝，反之亦然', async () => {
    const copySelection = vi.fn()
    const copyComposite = vi.fn()
    const harness = createHarness({ copySelection, copyComposite })

    await harness.controller.enter()
    harness.shortcuts.handlers.get(COMPOSITE)?.()

    await vi.waitFor(() => expect(copyComposite).toHaveBeenCalledTimes(1))
    expect(copySelection).not.toHaveBeenCalled()

    harness.shortcuts.handlers.get(COPY)?.()

    await vi.waitFor(() => expect(copySelection).toHaveBeenCalledTimes(1))
    expect(copyComposite).toHaveBeenCalledTimes(1)
  })

  it('缺省不给合成拷贝即不注册该键，冻结仍然成立', async () => {
    const harness = createHarness()

    await harness.controller.enter()

    expect(harness.controller.isFrozen()).toBe(true)
    expect(harness.shortcuts.handlers.has(COMPOSITE)).toBe(false)
  })

  it('合成拷贝失败只记日志，不拆掉冻结态', async () => {
    const harness = createHarness({
      copyComposite: async () => {
        throw new Error('抓取失败')
      },
    })

    await harness.controller.enter()
    harness.shortcuts.handlers.get(COMPOSITE)?.()

    await vi.waitFor(() =>
      expect(harness.warn.mock.calls.some(([message]) => String(message).includes('抓取失败'))).toBe(true),
    )
    expect(harness.controller.isFrozen()).toBe(true)
  })
})

describe('freeze controller: 锁定跳变触发翻译（拉取式轮询）', () => {
  async function frozenHarness(options: HarnessOptions & { onRegionLocked: (t: RegionLockTarget) => unknown }) {
    const clock = manualTimers()
    const harness = createHarness({ ...options, timers: clock.timers })
    harness.controller.start()
    harness.shortcuts.handlers.get(TRIGGER)?.()
    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(true))
    return { harness, clock }
  }

  it('冻结期不注册翻译热键——触发源是点击而非键盘', async () => {
    const { harness } = await frozenHarness({ onRegionLocked: vi.fn() })

    expect(harness.shortcuts.handlers.has(TRANSLATE)).toBe(false)
    expect(harness.shortcuts.handlers.has(COPY)).toBe(false)
    expect(harness.shortcuts.handlers.has(ESCAPE)).toBe(true)
  })

  it('缺省不给触发动作即不轮询，冻结仍然成立', async () => {
    const clock = manualTimers()
    const harness = createHarness({ timers: clock.timers })

    await harness.controller.enter()

    expect(clock.intervalCount()).toBe(0)
    expect(harness.controller.isFrozen()).toBe(true)
  })

  it('某屏首次出现锁定即触发一次，带上该屏与矩形', async () => {
    const onRegionLocked = vi.fn()
    const { harness, clock } = await frozenHarness({ onRegionLocked })
    const record = harness.windows.records[0]
    expect(record).toBeDefined()
    record!.locked = { x: 10, y: 20, width: 30, height: 40 }

    clock.tick()

    await vi.waitFor(() => expect(onRegionLocked).toHaveBeenCalledTimes(1))
    expect(onRegionLocked).toHaveBeenCalledWith({
      displayId: record!.display.id,
      region: { x: 10, y: 20, width: 30, height: 40 },
    })
  })

  it('未锁定的屏不触发', async () => {
    const onRegionLocked = vi.fn()
    const { harness, clock } = await frozenHarness({ onRegionLocked })

    clock.tick()

    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(true))
    expect(onRegionLocked).not.toHaveBeenCalled()
  })

  it('反复读到同一块锁定不重复触发', async () => {
    const onRegionLocked = vi.fn()
    const { harness, clock } = await frozenHarness({ onRegionLocked })
    const record = harness.windows.records[0]!
    record.locked = { x: 1, y: 2, width: 3, height: 4 }

    clock.tick()
    await vi.waitFor(() => expect(onRegionLocked).toHaveBeenCalledTimes(1))
    clock.tick()
    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(true))

    expect(onRegionLocked).toHaveBeenCalledTimes(1)
  })

  it('读锁定失败不当成未锁定：既不重复触发，也不逐轮刷日志', async () => {
    const onRegionLocked = vi.fn()
    const { harness, clock } = await frozenHarness({ onRegionLocked, displays: [primary] })
    const record = harness.windows.records[0]!
    const handle = record.handle
    record.locked = { x: 10, y: 20, width: 30, height: 40 }
    // 一轮轮询是异步的（且未读完时下一 tick 会被折叠），跨一个宏任务再断言才落到稳定态。
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

    clock.tick()
    await settle()
    expect(onRegionLocked).toHaveBeenCalledTimes(1)

    // 注入原语抖动：读失败若记成「这一屏没锁」，下一轮读到同一块锁就满足 null → 矩形的跳变判据，
    // 同一块区域会被重复 OCR 与重复的付费翻译；连续失败也只该在开头记一条日志。
    vi.mocked(handle.readLocked).mockRejectedValue(new Error('注入原语未就绪'))
    clock.tick()
    await settle()
    clock.tick()
    await settle()

    expect(onRegionLocked).toHaveBeenCalledTimes(1)
    expect(harness.warn.mock.calls.filter(([message]) => String(message).includes('读显示器'))).toHaveLength(1)

    // 读恢复后仍不该把同一块锁当成新的跳变。
    vi.mocked(handle.readLocked).mockImplementation(async () => record.locked)
    clock.tick()
    await settle()

    expect(onRegionLocked).toHaveBeenCalledTimes(1)
  })

  it('换到另一块锁定视为新选择，再触发一次', async () => {
    const onRegionLocked = vi.fn()
    const { harness, clock } = await frozenHarness({ onRegionLocked })
    const record = harness.windows.records[0]!
    record.locked = { x: 1, y: 2, width: 3, height: 4 }
    clock.tick()
    await vi.waitFor(() => expect(onRegionLocked).toHaveBeenCalledTimes(1))

    record.locked = { x: 5, y: 6, width: 7, height: 8 }
    clock.tick()

    await vi.waitFor(() => expect(onRegionLocked).toHaveBeenCalledTimes(2))
    expect(onRegionLocked).toHaveBeenLastCalledWith({
      displayId: record.display.id,
      region: { x: 5, y: 6, width: 7, height: 8 },
    })
  })

  it('多屏各自锁定各自触发，displayId 不串', async () => {
    const onRegionLocked = vi.fn()
    const { harness, clock } = await frozenHarness({ onRegionLocked })
    harness.windows.records[0]!.locked = { x: 1, y: 1, width: 1, height: 1 }
    harness.windows.records[1]!.locked = { x: 2, y: 2, width: 2, height: 2 }

    clock.tick()

    await vi.waitFor(() => expect(onRegionLocked).toHaveBeenCalledTimes(2))
    expect(onRegionLocked.mock.calls.map(([target]) => target.displayId).sort()).toEqual([
      primary.id,
      secondary.id,
    ])
  })

  it('退出冻结即停止轮询，之后再 tick 不再触发', async () => {
    const onRegionLocked = vi.fn()
    const { harness, clock } = await frozenHarness({ onRegionLocked })

    harness.controller.exit()

    expect(clock.activeCount()).toBe(0)
    harness.windows.records[0]!.locked = { x: 1, y: 1, width: 1, height: 1 }
    clock.tick()
    await vi.waitFor(() => expect(harness.controller.isFrozen()).toBe(false))
    expect(onRegionLocked).not.toHaveBeenCalled()
  })

  it('触发动作异步失败只记日志，不拆掉冻结', async () => {
    const onRegionLocked = vi.fn(async () => {
      throw new Error('翻译链路炸了')
    })
    const { harness, clock } = await frozenHarness({ onRegionLocked })
    harness.windows.records[0]!.locked = { x: 1, y: 1, width: 1, height: 1 }

    clock.tick()

    await vi.waitFor(() =>
      expect(harness.warn.mock.calls.some(([message]) => String(message).includes('翻译链路炸了'))).toBe(true),
    )
    expect(harness.controller.isFrozen()).toBe(true)
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
