/**
 * 全局快捷键的注册/注销收口。
 *
 * 直接调用 Electron `globalShortcut` 有两个坑，本模块把它们收敛到一处：
 * 其一，重复注册同一 accelerator 会返回 false 并静默丢掉新 handler（旧 handler 仍在），
 * 因此注册前必须先释放自己持有的同名键；其二，应用退出时若漏掉注销，快捷键会残留在系统
 * 中直到进程结束——用一个 owned 集合记录「我们注册过什么」，让注销只触碰自己的键。
 */

export interface ShortcutRegistrar {
  register(accelerator: string, handler: () => void): boolean
  unregister(accelerator: string): void
  isRegistered(accelerator: string): boolean
}

export class ShortcutManager {
  private readonly owned = new Map<string, () => void>()

  constructor(private readonly registrar: ShortcutRegistrar) {}

  /**
   * 注册并接管一个 accelerator。同名键先释放再注册，保证语义是「替换」而非「叠加」。
   * 返回注册是否成功（被系统/其它应用占用时为 false，此时不纳入 owned）。
   */
  register(accelerator: string, handler: () => void): boolean {
    this.unregister(accelerator)
    const ok = this.registrar.register(accelerator, handler)
    if (ok) {
      this.owned.set(accelerator, handler)
    }
    return ok
  }

  /** 只释放本管理器持有的键，不去动外部注册的同名快捷键。 */
  unregister(accelerator: string): void {
    if (!this.owned.has(accelerator)) {
      return
    }
    this.registrar.unregister(accelerator)
    this.owned.delete(accelerator)
  }

  unregisterAll(): void {
    for (const accelerator of [...this.owned.keys()]) {
      this.unregister(accelerator)
    }
  }

  registeredAccelerators(): string[] {
    return [...this.owned.keys()]
  }
}
