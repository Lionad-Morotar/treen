/**
 * 全局快捷键的注册/注销收口，双通道：capture（原生助手吞键）优先，globalShortcut 回退。
 *
 * 直接调用 Electron `globalShortcut` 有两个坑，本模块把它们收敛到一处：
 * 其一，重复注册同一 accelerator 会返回 false 并静默丢掉新 handler（旧 handler 仍在），
 * 因此注册前必须先释放自己持有的同名键；其二，应用退出时若漏掉注销，快捷键会残留在系统
 * 中直到进程结束——用一个 owned 集合记录「我们注册过什么」，让注销只触碰自己的键。
 *
 * capture 通道解决 globalShortcut 的另一个先天缺陷：macOS 侧它不吞事件，按键照旧派发给
 * 前台应用（VS Code 的同键位快捷键会被一并触发）。capture 可用（助手在岗且已授权）时键位
 * 走 tap；不可用、启动失败或运行中崩溃，全部迁回 globalShortcut——行为等同旧路径，
 * 绝不因为新通道让快捷键整体失效。
 *
 * capture 只承载「修饰键 + 单字符」键位（tap 靠事件字符命中）；Escape、功能键等不满足
 * 该形态的键位由 parseAccelerator 判 null，永远走 globalShortcut，两通道天然分工。
 */

import { parseAccelerator } from './hotkey-capture'

/** capture 通道面：由 freeze/hotkey-capture.ts 的 spawnHotkeyCaptureChannel 产出。 */
export interface ShortcutCaptureChannel {
  available(): boolean
  /** 整表同步助手键位表；不满足 capture 形态的键位由本模块过滤，助手不收它们。 */
  setHotkeys(accelerators: readonly string[]): void
  onHit(handler: (accelerator: string) => void): void
  onUnavailable(handler: (reason: string) => void): void
  dispose(): void
}

export interface ShortcutRegistrar {
  register(accelerator: string, handler: () => void): boolean
  unregister(accelerator: string): void
  isRegistered(accelerator: string): boolean
}

export class ShortcutManager {
  /** 逻辑注册表：accelerator → handler，与物理通道无关；注销只触碰这里记录的键。 */
  private readonly owned = new Map<string, () => void>()
  /** 当前由 capture 承载的键位；capture 失效时按它把键位迁回 registrar。 */
  private readonly captureOwned = new Set<string>()

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly capture?: ShortcutCaptureChannel,
  ) {
    if (capture) {
      capture.onHit((accelerator) => {
        // 助手只回显注册过的 accelerator；不在 owned 里说明刚被注销（注销与 tap 命中
        // 的竞态窗口），按没有 handler 处理，事件已被吞掉属预期。
        this.owned.get(accelerator)?.()
      })
      capture.onUnavailable(() => {
        // 键位迁移要逃过 capture.available() 分流，直接对 registrar 重注册。
        for (const accelerator of [...this.captureOwned]) {
          this.captureOwned.delete(accelerator)
          const handler = this.owned.get(accelerator)
          if (handler && !this.registrar.register(accelerator, handler)) {
            // global 侧也拿不下（被外部应用占用）是极端并发：保 handler 在 owned 里，
            // 注销语义仍然正确，只是这次按键收不到——与注册失败的历史行为一致。
          }
        }
        this.syncCapture()
      })
    }
  }

  /**
   * 注册并接管一个 accelerator。同名键先释放再注册，保证语义是「替换」而非「叠加」。
   * 返回注册是否成功（capture 可用时恒成功；global 通道被系统/其它应用占用时为 false，
   * 此时不纳入 owned）。
   */
  register(accelerator: string, handler: () => void): boolean {
    this.unregister(accelerator)
    this.owned.set(accelerator, handler)
    // 形态可接才走 capture：Escape、功能键等助手无法按字符命中的键位必须留在
    // globalShortcut 上，否则进了 capture 表也收不到命中，快捷键整体失效。
    if (this.capture?.available() && parseAccelerator(accelerator) !== null) {
      this.captureOwned.add(accelerator)
      this.syncCapture()
      return true
    }
    const ok = this.registrar.register(accelerator, handler)
    if (!ok) {
      this.owned.delete(accelerator)
    }
    return ok
  }

  /** 只释放本管理器持有的键，不去动外部注册的同名快捷键。 */
  unregister(accelerator: string): void {
    if (!this.owned.has(accelerator)) {
      return
    }
    if (this.captureOwned.delete(accelerator)) {
      this.syncCapture()
    } else {
      this.registrar.unregister(accelerator)
    }
    this.owned.delete(accelerator)
  }

  unregisterAll(): void {
    for (const accelerator of [...this.owned.keys()]) {
      this.unregister(accelerator)
    }
    this.capture?.dispose()
  }

  registeredAccelerators(): string[] {
    return [...this.owned.keys()]
  }

  /** 键位表变化后整表同步给助手（capture 只收它支持的形态，global 侧键位不进 tap 表）。 */
  private syncCapture(): void {
    if (!this.capture) {
      return
    }
    const accelerators = [...this.owned.keys()].filter((accelerator) => this.captureOwned.has(accelerator))
    this.capture.setHotkeys(accelerators)
  }
}
