import { describe, expect, it, vi } from 'vitest'
import {
  createFreezeController,
  type FreezeFrame,
  type OverlayWindowHandle,
} from '../src/freeze/controller'
import { ShortcutManager, type ShortcutRegistrar } from '../src/freeze/shortcuts'
import type { DisplayLike } from '../src/freeze/geometry'

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

function fakeShortcuts() {
  const handlers = new Map<string, () => void>()
  const registrar: ShortcutRegistrar = {
    register: (accelerator, handler) => {
      if (handlers.has(accelerator)) {
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
}

function createHarness(options: HarnessOptions = {}) {
  const displays = options.displays ?? [primary, secondary]
  const shortcuts = fakeShortcuts()
  const windows = fakeWindows(options.failOnDisplayId)
  const captureFrames = vi.fn(async () => options.frames ?? displays.map(frameFor))
  const warn = vi.fn()
  const info = vi.fn()
  const controller = createFreezeController({
    listDisplays: () => displays,
    captureFrames,
    windows: windows.factory,
    shortcuts: shortcuts.manager,
    triggerAccelerator: TRIGGER,
    exitAccelerator: ESCAPE,
    pointOfInterest: () => options.pointer ?? { x: 10, y: 10 },
    logger: { warn, info },
  })
  return { controller, shortcuts, windows, captureFrames, warn, displays }
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
