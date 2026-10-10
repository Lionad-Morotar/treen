import { describe, expect, it, vi } from 'vitest'
import {
  ShortcutManager,
  type ShortcutCaptureChannel,
  type ShortcutRegistrar,
} from '../src/freeze/shortcuts'

interface RegistrarHarness {
  registrar: ShortcutRegistrar
  register: ReturnType<typeof vi.fn>
  unregister: ReturnType<typeof vi.fn>
  handlers: Map<string, () => void>
}

function createHarness(accept: (accelerator: string) => boolean = () => true): RegistrarHarness {
  const handlers = new Map<string, () => void>()
  const register = vi.fn((accelerator: string, handler: () => void) => {
    if (!accept(accelerator) || handlers.has(accelerator)) {
      return false
    }
    handlers.set(accelerator, handler)
    return true
  })
  const unregister = vi.fn((accelerator: string) => {
    handlers.delete(accelerator)
  })
  return {
    registrar: {
      register,
      unregister,
      isRegistered: (accelerator: string) => handlers.has(accelerator),
    },
    register,
    unregister,
    handlers,
  }
}

describe('ShortcutManager.register', () => {
  it('delegates to the registrar and tracks ownership', () => {
    const harness = createHarness()
    const manager = new ShortcutManager(harness.registrar)

    expect(manager.register('CommandOrControl+Shift+X', () => {})).toBe(true)
    expect(harness.register).toHaveBeenCalledTimes(1)
    expect(manager.registeredAccelerators()).toEqual(['CommandOrControl+Shift+X'])
  })

  it('invokes the stored handler through the registrar', () => {
    const harness = createHarness()
    const manager = new ShortcutManager(harness.registrar)
    const handler = vi.fn()

    manager.register('Escape', handler)
    harness.handlers.get('Escape')?.()

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('replaces an owned accelerator instead of leaking the previous registration', () => {
    const harness = createHarness()
    const manager = new ShortcutManager(harness.registrar)

    manager.register('Escape', () => {})
    manager.register('Escape', () => {})

    expect(harness.unregister).toHaveBeenCalledWith('Escape')
    expect(manager.registeredAccelerators()).toEqual(['Escape'])
  })

  it('does not track an accelerator the registrar refused', () => {
    const harness = createHarness(() => false)
    const manager = new ShortcutManager(harness.registrar)

    expect(manager.register('Escape', () => {})).toBe(false)
    expect(manager.registeredAccelerators()).toEqual([])
  })
})

describe('ShortcutManager.unregister', () => {
  it('releases an owned accelerator', () => {
    const harness = createHarness()
    const manager = new ShortcutManager(harness.registrar)
    manager.register('Escape', () => {})

    manager.unregister('Escape')

    expect(harness.unregister).toHaveBeenCalledWith('Escape')
    expect(manager.registeredAccelerators()).toEqual([])
  })

  it('ignores accelerators it never owned, leaving foreign registrations untouched', () => {
    const harness = createHarness()
    const manager = new ShortcutManager(harness.registrar)

    manager.unregister('CommandOrControl+Q')

    expect(harness.unregister).not.toHaveBeenCalled()
  })
})

describe('ShortcutManager.unregisterAll', () => {
  it('releases every owned accelerator', () => {
    const harness = createHarness()
    const manager = new ShortcutManager(harness.registrar)
    manager.register('Escape', () => {})
    manager.register('CommandOrControl+Shift+X', () => {})

    manager.unregisterAll()

    expect(harness.unregister).toHaveBeenCalledTimes(2)
    expect(manager.registeredAccelerators()).toEqual([])
  })
})

describe('registrar 抛异常（Electron 对解析不了的 accelerator 是抛异常而非返回失败）', () => {
  it('register 抛异常按失败处理：返回 false、不进 owned，退出时不再炸', () => {
    const registrar: ShortcutRegistrar = {
      register: () => {
        throw new TypeError('Error processing argument at index 0, conversion failure from Alt+Shift+˛')
      },
      unregister: () => {
        throw new TypeError('conversion failure from Alt+Shift+˛')
      },
      isRegistered: () => false,
    }
    const manager = new ShortcutManager(registrar)

    expect(manager.register('Alt+Shift+˛', () => {})).toBe(false)
    expect(manager.registeredAccelerators()).toEqual([])
    expect(() => manager.unregisterAll()).not.toThrow()
  })

  it('unregister 抛异常就地吞掉：owned 照常清除，unregisterAll 不再抛', () => {
    const registrar: ShortcutRegistrar = {
      register: () => true,
      unregister: () => {
        throw new TypeError('conversion failure from CommandOrControl+Shift+X')
      },
      isRegistered: () => false,
    }
    const manager = new ShortcutManager(registrar)
    manager.register('CommandOrControl+Shift+X', () => {})

    expect(() => manager.unregisterAll()).not.toThrow()
    expect(manager.registeredAccelerators()).toEqual([])
  })
})

interface CaptureHarness {
  channel: ShortcutCaptureChannel
  setHotkeys: ReturnType<typeof vi.fn>
  available: ReturnType<typeof vi.fn>
  hit: (accelerator: string) => void
  unavailable: (reason: string) => void
  recovered(): void
  dispose: ReturnType<typeof vi.fn>
}

function createCaptureHarness(availableNow = true): CaptureHarness {
  let hitHandler: ((accelerator: string) => void) | null = null
  let unavailableHandler: ((reason: string) => void) | null = null
  let recoveredHandler: (() => void) | null = null
  let up = availableNow
  const setHotkeys = vi.fn()
  const available = vi.fn(() => up)
  const dispose = vi.fn()
  return {
    channel: {
      available: available as unknown as ShortcutCaptureChannel['available'],
      setHotkeys: setHotkeys as unknown as ShortcutCaptureChannel['setHotkeys'],
      onHit: (handler) => {
        hitHandler = handler
      },
      onUnavailable: (handler) => {
        unavailableHandler = handler
      },
      onRecovered: (handler) => {
        recoveredHandler = handler
      },
      dispose: dispose as unknown as ShortcutCaptureChannel['dispose'],
    },
    setHotkeys,
    available,
    hit: (accelerator) => hitHandler?.(accelerator),
    unavailable: (reason) => {
      // 替身语义对齐真通道：失效通知即 available 翻 false。
      up = false
      unavailableHandler?.(reason)
    },
    recovered: () => {
      // 恢复通知即 available 翻 true。
      up = true
      recoveredHandler?.()
    },
    dispose,
  }
}

describe('ShortcutManager with capture channel', () => {
  it('routes tap-compatible accelerators to capture and skips the registrar', () => {
    const harness = createHarness()
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel)

    expect(manager.register('CommandOrControl+Shift+X', () => {})).toBe(true)
    expect(harness.register).not.toHaveBeenCalled()
    expect(manager.registeredAccelerators()).toEqual(['CommandOrControl+Shift+X'])
    expect(capture.setHotkeys).toHaveBeenCalledWith(['CommandOrControl+Shift+X'])
  })

  it('keeps character-unmatchable accelerators on the global registrar', () => {
    const harness = createHarness()
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel)

    expect(manager.register('Escape', () => {})).toBe(true)
    expect(harness.register).toHaveBeenCalledWith('Escape', expect.any(Function))
    // Escape 从不进 capture 表，键表无需同步。
    expect(capture.setHotkeys).not.toHaveBeenCalled()
  })

  it('falls back to the registrar when capture is unavailable and still registers', () => {
    const harness = createHarness()
    const capture = createCaptureHarness(false)
    const manager = new ShortcutManager(harness.registrar, capture.channel)

    expect(manager.register('CommandOrControl+Shift+X', () => {})).toBe(true)
    expect(harness.register).toHaveBeenCalledWith('CommandOrControl+Shift+X', expect.any(Function))
    expect(manager.registeredAccelerators()).toEqual(['CommandOrControl+Shift+X'])
  })

  it('delivers capture hits to the registered handler', () => {
    const harness = createHarness()
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel)
    const handler = vi.fn()

    manager.register('CommandOrControl+Shift+X', handler)
    capture.hit('CommandOrControl+Shift+X')

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('migrates capture-owned accelerators back to the registrar when the channel dies', () => {
    const harness = createHarness()
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel)

    manager.register('CommandOrControl+Shift+X', () => {})
    manager.register('CommandOrControl+Shift+C', () => {})
    expect(harness.register).not.toHaveBeenCalled()

    capture.unavailable('crashed')

    expect(harness.register).toHaveBeenCalledWith('CommandOrControl+Shift+X', expect.any(Function))
    expect(harness.register).toHaveBeenCalledWith('CommandOrControl+Shift+C', expect.any(Function))
    expect(manager.registeredAccelerators()).toEqual(['CommandOrControl+Shift+X', 'CommandOrControl+Shift+C'])
    // 迁移后新注册直接走 registrar（通道已不可用）。
    manager.register('CommandOrControl+J', () => {})
    expect(harness.register).toHaveBeenCalledWith('CommandOrControl+J', expect.any(Function))
  })

  it('unregister releases a capture-owned accelerator by syncing the table', () => {
    const harness = createHarness()
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel)

    manager.register('CommandOrControl+Shift+X', () => {})
    manager.unregister('CommandOrControl+Shift+X')

    expect(harness.unregister).not.toHaveBeenCalled()
    expect(capture.setHotkeys).toHaveBeenLastCalledWith([])
    expect(manager.registeredAccelerators()).toEqual([])
  })

  it('leaves the channel alive on unregisterAll: disposal belongs to the assembly layer', () => {
    const harness = createHarness()
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel)

    manager.register('CommandOrControl+Shift+X', () => {})
    manager.unregisterAll()

    // capture 侧的键不逐个退 global（本来就没在那边）；通道的生死归装配层，
    // unregisterAll 只清键位，不收通道（main 的退出钩子已单独 dispose）。
    expect(harness.unregister).not.toHaveBeenCalled()
    expect(capture.dispose).not.toHaveBeenCalled()
    expect(manager.registeredAccelerators()).toEqual([])
  })

  it('migrates degraded accelerators back to capture when the helper recovers', () => {
    const harness = createHarness()
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel)
    const handler = vi.fn()

    manager.register('CommandOrControl+Shift+X', handler)
    capture.unavailable('crashed')
    expect(harness.register).toHaveBeenCalledWith('CommandOrControl+Shift+X', handler)

    capture.recovered()

    // 恢复后键位迁回 capture：global 侧注销、键表重新下发。
    expect(harness.unregister).toHaveBeenCalledWith('CommandOrControl+Shift+X')
    expect(capture.setHotkeys).toHaveBeenLastCalledWith(['CommandOrControl+Shift+X'])
    capture.hit('CommandOrControl+Shift+X')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('keeps owned semantics when a degraded accelerator cannot re-register on global', () => {
    const harness = createHarness((accelerator) => accelerator !== 'CommandOrControl+Shift+X')
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel, {
      warn: vi.fn(),
      info: vi.fn(),
    })

    manager.register('CommandOrControl+Shift+X', () => {})
    capture.unavailable('crashed')

    // global 侧被占（迁移失败）：键位保留在 owned 里，注销语义仍然正确。
    expect(manager.registeredAccelerators()).toEqual(['CommandOrControl+Shift+X'])
  })

  it('ignores capture hits for accelerators it no longer owns', () => {
    const harness = createHarness()
    const capture = createCaptureHarness()
    const manager = new ShortcutManager(harness.registrar, capture.channel)
    const handler = vi.fn()

    manager.register('CommandOrControl+Shift+X', handler)
    manager.unregister('CommandOrControl+Shift+X')

    expect(() => capture.hit('CommandOrControl+Shift+X')).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })
})
