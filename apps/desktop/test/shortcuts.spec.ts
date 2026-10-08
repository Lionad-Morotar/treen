import { describe, expect, it, vi } from 'vitest'
import { ShortcutManager, type ShortcutRegistrar } from '../src/freeze/shortcuts'

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
