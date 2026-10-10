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
 * 走 tap；不可用、启动失败或运行中崩溃，立刻迁回 globalShortcut——行为等同旧路径，快捷键
 * 在崩溃窗口内也不消失；助手恢复后自动迁回 capture，吞键重新生效。
 *
 * capture 只承载「Command(+Shift)+单字符」键位（tap 靠事件字符命中，Option/Control 参与布局
 * 的字符合成、Escape 等功能键无字符），形态判定在 parseAccelerator；不满足的键位永远走
 * globalShortcut，两通道天然分工。通道生命周期归装配层（dispose 在 main 的退出钩子里），
 * 本模块只负责键位在两通道间的迁移。
 */

import { parseAccelerator } from './hotkey-capture'

/** capture 通道面：由 freeze/hotkey-capture.ts 的 spawnHotkeyCaptureChannel 产出。 */
export interface ShortcutCaptureChannel {
  available(): boolean
  /** 整表同步助手键位表；不满足 capture 形态的键位由本模块过滤，助手不收它们。 */
  setHotkeys(accelerators: readonly string[]): void
  onHit(handler: (accelerator: string) => void): void
  /** 通道失效（崩溃/权限被撤）：已 capture 的键位应立即迁回 globalShortcut。 */
  onUnavailable(handler: (reason: string) => void): void
  /** 助手重启恢复：迁走的键位应迁回 capture，吞键重新生效。 */
  onRecovered(handler: () => void): void
  dispose(): void
}

export interface ShortcutRegistrar {
  register(accelerator: string, handler: () => void): boolean
  unregister(accelerator: string): void
  isRegistered(accelerator: string): boolean
}

export interface ShortcutManagerLogger {
  warn(message: string): void
  info(message: string): void
}

export class ShortcutManager {
  /** 逻辑注册表：accelerator → handler，与物理通道无关；注销只触碰这里记录的键。 */
  private readonly owned = new Map<string, () => void>()
  /** 当前由 capture 承载的键位；capture 失效时按它把键位迁回 registrar。 */
  private readonly captureOwned = new Set<string>()

  constructor(
    private readonly registrar: ShortcutRegistrar,
    private readonly capture?: ShortcutCaptureChannel,
    private readonly logger?: ShortcutManagerLogger,
  ) {
    if (capture) {
      capture.onHit((accelerator) => {
        // 助手只回显注册过的 accelerator；不在 owned 里说明刚被注销（注销与 tap 命中
        // 的竞态窗口），按没有 handler 处理，事件已被吞掉属预期。
        this.owned.get(accelerator)?.()
      })
      capture.onUnavailable((reason) => {
        // 崩溃窗口内键位必须保持可用：立刻迁回 global，吞键暂失、功能不失。
        for (const accelerator of [...this.captureOwned]) {
          this.captureOwned.delete(accelerator)
          const handler = this.owned.get(accelerator)
          if (handler && !this.registrar.register(accelerator, handler)) {
            // global 侧也拿不下（被外部应用占用）是极端并发：保 handler 在 owned 里，
            // 注销语义仍然正确，只是这次按键收不到——与注册失败的历史行为一致。
            this.logger?.warn(`capture 降级时 ${accelerator} 迁回 global 失败（可能被其它应用占用）`)
          }
        }
        this.logger?.warn(`热键 capture 降级（${reason}），同键位暂由 globalShortcut 监听、不再吞键`)
        this.syncCapture()
      })
      capture.onRecovered(() => {
        // 恢复后把还在 owned 里的可 capture 键位迁回 tap；迁移瞬间（unregister 后
        // register）有毫秒级双空窗，远短于崩溃窗口，可接受。
        for (const accelerator of [...this.owned.keys()]) {
          if (parseAccelerator(accelerator) === null) {
            continue
          }
          const handler = this.owned.get(accelerator)
          if (handler === undefined) {
            continue
          }
          this.registrar.unregister(accelerator)
          this.captureOwned.add(accelerator)
          void handler
        }
        this.logger?.info('热键 capture 已恢复，组合键重新吞键')
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
    // 形态可接才走 capture：Escape、功能键、Option/Control 组合等助手无法按注册字符
    // 命中的键位必须留在 globalShortcut 上，否则进了 capture 表也收不到命中，快捷键失效。
    if (this.capture?.available() && parseAccelerator(accelerator) !== null) {
      this.owned.set(accelerator, handler)
      this.captureOwned.add(accelerator)
      this.syncCapture()
      return true
    }
    let ok: boolean
    try {
      ok = this.registrar.register(accelerator, handler)
    } catch (error) {
      // Electron 对解析不了的 accelerator 是抛异常而非返回 false（设置页曾放行 macOS 死键字符
      // 拼出的非法键位）。异常漏出去会在注册时炸一次、退出 dispose 再炸一次，就是主进程崩窗，
      // 故按「注册失败」同型处理：不进 owned、返回 false，让调用方的回落逻辑接手。
      this.logger?.warn(`热键 ${accelerator} 注册失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
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
    if (this.captureOwned.delete(accelerator)) {
      this.syncCapture()
    } else {
      try {
        this.registrar.unregister(accelerator)
      } catch (error) {
        // 注销路径的异常必须就地吞掉：这里在退出钩子的调用链上，抛出去就是退出崩窗。
        // owned 照常清除，否则此后每次退出都会在同一处再炸一次。
        this.logger?.warn(`热键 ${accelerator} 注销失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
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

  /** 键位表变化后整表同步给助手（capture 只收它支持的形态，global 侧键位不进 tap 表）。 */
  private syncCapture(): void {
    if (!this.capture) {
      return
    }
    const accelerators = [...this.owned.keys()].filter((accelerator) => this.captureOwned.has(accelerator))
    this.capture.setHotkeys(accelerators)
  }
}
