import { spawn } from 'node:child_process'
import { IPC_CHANNELS } from '@treen/ipc'

/**
 * 热键 capture 通道：spawn 原生助手（CGEvent tap）在系统派发之前吞掉已注册键位。
 *
 * globalShortcut 在 macOS 不吞事件——按键照旧派发给前台应用（VS Code 的同键位快捷键会被
 * 一并触发），要吞键必须经助手的过滤型 tap，代价是「输入监控」授权。本模块把 spawn、
 * 行协议解析、崩溃降级与退出收口集中在一处，全部依赖（进程创建、真实二进制路径）可注入，
 * 纯 Node 可测；真实装配在 main。
 *
 * 回退语义归调用方（ShortcutManager / 装配层）：spawn 返回 null、available() 变 false、
 * probe 得 false，都意味着「走 globalShortcut，行为等同无本模块」。通道失效立刻通知
 * （unavailable），恢复后同样立刻通知（recovered），键位在两通道间的迁移由 ShortcutManager
 * 承载——快捷键在崩溃窗口内也不消失。
 */

/** accelerator → 键表条目（tap 侧命中判定用的修饰键与单字符）。 */
export interface ParsedHotkey {
  accel: string
  mods: { cmd: boolean; shift: boolean; ctrl: boolean; opt: boolean }
  key: string
}

/**
 * 解析 Electron accelerator 成 capture 键表条目。只接受「Command(+Shift)+单字母/数字」：
 * - tap 靠事件 unicode 字符命中；Command 不参与布局的字符合成（Cmd+Shift+X 字符仍是大写 X），
 *   Option/Control 会把字符翻译成别的码位（Option+X → ≈、Control+X → 控制符）、
 *   裸字符/纯 Shift 会吞掉正常打字、功能键（Escape、F1…）无字符可判——以上一律返回 null，
 *   由 ShortcutManager 落回 globalShortcut（丢吞键、保功能）。
 * - Super/Meta 在 Electron 的 macOS 语义就是 Command；本助手是 macOS 专属，其它平台
 *   不做投机展开。
 */
export function parseAccelerator(accel: string): ParsedHotkey | null {
  // 助手按行回显 accelerator，控制字符会劈开行协议，源头就拒掉。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(accel)) {
    return null
  }
  const parts = accel.split('+').map((part) => part.trim()).filter((part) => part.length > 0)
  if (parts.length < 2) {
    return null
  }
  const key = parts[parts.length - 1]
  if (key === undefined || !/^[a-z0-9]$/i.test(key)) {
    return null
  }
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()))
  const known = new Set([
    'commandorcontrol',
    'cmdorctrl',
    'command',
    'cmd',
    'control',
    'ctrl',
    'shift',
    'alt',
    'option',
    'opt',
    'super',
    'meta',
  ])
  for (const modifier of modifiers) {
    if (!known.has(modifier)) {
      return null
    }
  }
  const commandLike =
    modifiers.has('commandorcontrol') ||
    modifiers.has('cmdorctrl') ||
    modifiers.has('command') ||
    modifiers.has('cmd') ||
    modifiers.has('super') ||
    modifiers.has('meta')
  // 无 Command 的组合（Ctrl/Alt/Shift/裸字符）不是 capture 能力面：字符合成或打字破坏问题。
  if (process.platform !== 'darwin' || !commandLike) {
    return null
  }
  return {
    accel,
    mods: {
      cmd: true,
      ctrl: false,
      opt: false,
      shift: modifiers.has('shift'),
    },
    key: key.toLowerCase(),
  }
}

/** 助手 stdout 的行事件汇。所有回调可选，解析面不为缺回调的调用方抛错。 */
export interface CaptureLineEvents {
  onReady?(): void
  onHit?(accel: string): void
  onTapRebuilt?(): void
  onTapError?(reason: string): void
  onPermission?(ok: boolean): void
}

/** 把 stdout 拆成完整行再喂给解析器；缓冲残留（无尾换行的最后半行）在流关闭时自然丢弃。 */
export function pipeStdoutLines(
  stream: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null,
  onLine: (line: string) => void,
): void {
  let buffer = ''
  stream?.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString()
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      onLine(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  })
}

/**
 * 行协议解析器：喂入助手 stdout 的原始行，分发成结构化事件。
 * 非法/未知输出（未来版本新增的行、乱码）一律忽略——助手的输出是观测面不是命令面，
 * 任何一行坏数据都不该打断快捷键链路。
 */
export function createCaptureLineParser(events: CaptureLineEvents): (line: string) => void {
  return (line) => {
    const trimmed = line.trim()
    if (trimmed === 'READY') {
      events.onReady?.()
      return
    }
    if (trimmed === 'TAP-REBUILT') {
      events.onTapRebuilt?.()
      return
    }
    if (trimmed.startsWith('HIT ')) {
      const accel = trimmed.slice(4).trim()
      if (accel.length > 0) {
        events.onHit?.(accel)
      }
      return
    }
    if (trimmed.startsWith('TAP-ERROR')) {
      events.onTapError?.(trimmed.slice('TAP-ERROR'.length).trim())
      return
    }
    if (trimmed.startsWith('PERMISSION ')) {
      events.onPermission?.(trimmed.slice('PERMISSION '.length).trim() === 'ok')
    }
  }
}

/** spawn 出的助手进程的最小面：测试用假进程替身，真实侧是 child_process.ChildProcess。 */
export interface CaptureProcessLike {
  pid?: number
  stdin: { write(chunk: string): unknown; end(): unknown } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnLike = (command: string, args: readonly string[]) => CaptureProcessLike

export interface HotkeyCaptureLogger {
  info(message: string): void
  warn(message: string): void
}

/** capture 通道当前状态，设置页据此区分「吞键已生效」与「监听模式」。 */
export interface HotkeyCaptureStatus {
  /** 装配层是否已确定授权态（启动 probe 完成）；false 时其余字段不可信，UI 应保持检查中 */
  ready: boolean
  /** 助手在岗且 tap 生效（崩溃降级期间为 false） */
  active: boolean
  /** 输入监控授权态；运行中因权限被撤而降级时翻 false */
  authorized: boolean
  /** 最近一次降级原因（TAP-ERROR 的 reason 或 spawn 失败信息），无降级为 null */
  reason: string | null
}

/**
 * 交给 ShortcutManager 的 capture 通道面。unavailable 在崩溃瞬间即发（键位立刻迁回
 * globalShortcut，崩溃窗口内快捷键不断），重启恢复后发 recovered（键位迁回 capture）。
 */
export interface HotkeyCaptureChannel {
  /** 整表替换助手键位表；不满足 capture 形态的键位由本模块过滤，助手不收它们。 */
  setHotkeys(accelerators: readonly string[]): void
  onHit(handler: (accelerator: string) => void): void
  onUnavailable(handler: (reason: string) => void): void
  onRecovered(handler: () => void): void
  available(): boolean
  status(): HotkeyCaptureStatus
  dispose(): void
}

export interface SpawnChannelOptions {
  helperPath: string
  hotkeys: readonly string[]
  spawn?: SpawnLike
  timeoutMs?: number
  logger?: HotkeyCaptureLogger
}

const DEFAULT_READY_TIMEOUT_MS = 3000
const RESPAWN_DELAY_MS = 600
/** 滑动窗口内的崩溃预算：超出即永久降级，不再重启。 */
const RESPAWN_BUDGET = 3
const RESPAWN_BUDGET_WINDOW_MS = 60_000

interface ResolvedOptions {
  helperPath: string
  timeoutMs: number
  spawn: SpawnLike
  logger?: HotkeyCaptureLogger
}

/**
 * 等待一个刚 spawn 的助手报 READY 或失败。READY 前的 TAP-ERROR、异常退出、spawn error、
 * 超时都算启动失败；失败时带原因（TAP-ERROR 的 reason 优先，供 status 呈现）。
 * 用 close（stdio 全关）而非 exit 作「没等到结果」的判据：短命进程的 exit 可以先于
 * 管道里最后几字节送达，exit 判据会抢在 PERMISSION/READY 之前误判失败。
 */
function awaitReady(proc: CaptureProcessLike, timeoutMs: number): Promise<{ ok: boolean; reason: string | null }> {
  return new Promise((resolve) => {
    let tapError: string | null = null
    let resolved = false
    const parser = createCaptureLineParser({
      onReady: () => finish({ ok: true, reason: null }),
      onTapError: (reason) => {
        tapError = reason || 'unknown'
        finish({ ok: false, reason: tapError })
      },
    })
    function finish(result: { ok: boolean; reason: string | null }): void {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      finish({ ok: false, reason: tapError ?? 'timeout' })
    }, timeoutMs)
    proc.on('close', () => finish({ ok: false, reason: tapError ?? 'exited' }))
    proc.on('error', () => finish({ ok: false, reason: tapError ?? 'spawn-error' }))
    pipeStdoutLines(proc.stdout, (line) => {
      parser(line)
      // READY 处理器已直接 finish；这里兜「一行都没来进程就挂了」之外的 TAP-ERROR 形态。
      if (tapError !== null) {
        finish({ ok: false, reason: tapError })
      }
    })
  })
}

function hotkeyEntries(hotkeys: readonly string[]): ParsedHotkey[] {
  return hotkeys.map(parseAccelerator).filter((entry): entry is ParsedHotkey => entry !== null)
}

function buildArgs(hotkeys: readonly string[]): string[] {
  return ['--hotkeys', JSON.stringify({ hotkeys: hotkeyEntries(hotkeys) })]
}

function sendSet(proc: CaptureProcessLike, hotkeys: readonly string[]): void {
  try {
    proc.stdin?.write(JSON.stringify({ op: 'set', hotkeys: hotkeyEntries(hotkeys) }) + '\n')
  } catch {
    // stdin 已随进程退出关闭：close 事件会接手崩溃处置
  }
}

function defaultSpawn(command: string, args: readonly string[]): CaptureProcessLike {
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
}

/**
 * spawn 助手并建立通道。返回 null 的全部形态：二进制缺失（spawn ENOENT）、未授权
 * （TAP-ERROR permission-denied）、启动超时——调用方一律回退 globalShortcut。
 *
 * 崩溃处置：立刻发 unavailable（键位迁回 globalShortcut），随后按预算自动重启；恢复 READY
 * 后发 recovered（键位迁回 capture）。预算（滑动窗口内 RESPAWN_BUDGET 次崩溃）耗尽即永久
 * 降级——权限被撤或二进制损坏时，重启风暴只会反复吞掉启动期按键。
 */
export async function spawnHotkeyCaptureChannel(options: SpawnChannelOptions): Promise<HotkeyCaptureChannel | null> {
  const resolved: ResolvedOptions = {
    helperPath: options.helperPath,
    timeoutMs: options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    spawn: options.spawn ?? defaultSpawn,
    logger: options.logger,
  }
  let proc: CaptureProcessLike
  try {
    proc = resolved.spawn(resolved.helperPath, buildArgs(options.hotkeys))
  } catch {
    return null
  }
  const boot = await awaitReady(proc, resolved.timeoutMs)
  if (!boot.ok) {
    try {
      proc.kill('SIGTERM')
    } catch {
      // 进程已自行退出，无需处理
    }
    resolved.logger?.warn(
      `热键 capture 助手启动失败（${boot.reason ?? 'unknown'}），回退到 globalShortcut 监听模式`,
    )
    return null
  }

  let disposed = false
  let active = true
  let lastReason: string | null = null
  let hitHandler: ((accelerator: string) => void) | null = null
  let unavailableHandler: ((reason: string) => void) | null = null
  let recoveredHandler: (() => void) | null = null
  let currentHotkeys: readonly string[] = options.hotkeys
  /** respawn 已 spawn 但尚未结算 READY 的在途进程：dispose 时必须一并收掉。 */
  let pendingProc: CaptureProcessLike | null = null
  const crashTimes: number[] = []
  const runtimeParser = createCaptureLineParser({
    onHit: (accel) => hitHandler?.(accel),
    onTapRebuilt: () => resolved.logger?.info('热键 capture tap 被系统禁用后已重建'),
  })

  /** 收掉一个进程：stdin 关闭 + SIGTERM；吞 EPIPE 类写错误（进程可能已死）。 */
  function terminate(target: CaptureProcessLike): void {
    try {
      target.stdin?.end()
    } catch {
      // stdin 已随进程退出关闭
    }
    try {
      target.kill('SIGTERM')
    } catch {
      // 进程已自行退出
    }
  }

  function attachRuntime(target: CaptureProcessLike): void {
    pipeStdoutLines(target.stdout, runtimeParser)
    // stderr 只采前几行：dyld/Swift 运行时的报错是「回退监听模式」时最关键的诊断面，
    // 但它可能持续输出，全量转发会刷屏。管道必须有人读，否则缓冲写满会顶住助手。
    let stderrLines = 0
    target.stderr?.on('data', (chunk) => {
      if (stderrLines >= 5 || disposed) {
        return
      }
      const text = (typeof chunk === 'string' ? chunk : chunk.toString()).trim()
      if (text.length === 0) {
        return
      }
      stderrLines += 1
      resolved.logger?.warn(`助手 stderr：${text.split('\n')[0] ?? ''}`)
    })
    target.on('close', (code) => {
      if (!disposed) {
        respawn(String(code ?? 'signal'))
      }
    })
    target.on('error', (error) => {
      if (!disposed) {
        respawn(error.message)
      }
    })
  }

  function respawn(reason: string): void {
    // 崩溃瞬间即宣布降级：ShortcutManager 立刻把键位迁回 globalShortcut，重启窗口内
    // 快捷键照常工作，只是退回监听模式（不吞键）。
    active = false
    lastReason = reason
    unavailableHandler?.(reason)
    const now = Date.now()
    while (crashTimes.length > 0 && now - (crashTimes[0] ?? 0) > RESPAWN_BUDGET_WINDOW_MS) {
      crashTimes.shift()
    }
    crashTimes.push(now)
    if (crashTimes.length > RESPAWN_BUDGET) {
      resolved.logger?.warn(`热键 capture 助手在 ${RESPAWN_BUDGET_WINDOW_MS / 1000}s 内已崩溃 ${crashTimes.length} 次，停止重启并保持监听模式`)
      return
    }
    setTimeout(() => {
      if (disposed) {
        return
      }
      let next: CaptureProcessLike
      try {
        next = resolved.spawn(resolved.helperPath, buildArgs(currentHotkeys))
      } catch {
        return
      }
      pendingProc = next
      void awaitReady(next, resolved.timeoutMs).then((boot) => {
        if (pendingProc === next) {
          pendingProc = null
        }
        if (disposed) {
          // dispose 与在途 respawn 竞争：这个新进程还没有任何引用指向它，
          // 不收掉就会永久持有吞键 tap 而无人能及。
          terminate(next)
          return
        }
        if (!boot.ok) {
          terminate(next)
          // 权限类失败要回流到状态面：设置页据此给出「去授权」入口。
          lastReason = boot.reason ?? lastReason
          return
        }
        active = true
        lastReason = null
        proc = next
        attachRuntime(next)
        sendSet(next, currentHotkeys)
        resolved.logger?.info('热键 capture 助手已重启恢复')
        recoveredHandler?.()
      })
    }, RESPAWN_DELAY_MS)
  }

  attachRuntime(proc)

  return {
    setHotkeys(accelerators) {
      currentHotkeys = accelerators
      if (!disposed && active) {
        sendSet(proc, accelerators)
      }
    },
    onHit(handler) {
      hitHandler = handler
    },
    onUnavailable(handler) {
      unavailableHandler = handler
    },
    onRecovered(handler) {
      recoveredHandler = handler
    },
    available: () => active && !disposed,
    status: () => ({
      ready: true,
      active: active && !disposed,
      // 权限类失败（tap 建不起来）意味着授权已不可信，让设置页给出授权入口；
      // 其余失败（被杀等）授权仍然成立。
      authorized: lastReason === null || !lastReason.includes('permission'),
      reason: lastReason,
    }),
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      terminate(proc)
      // 在途 respawn 的进程同样收掉（不等它的 READY/超时结算）。
      if (pendingProc !== null) {
        terminate(pendingProc)
        pendingProc = null
      }
    },
  }
}

/**
 * 授权探测：跑一次助手 --probe（CGPreflight 只查询不弹窗）。
 * 返回 null 表示探测本身不可达（二进制缺失/超时），true/false 是授权态。
 */
export function probeHotkeyCapturePermission(options: {
  helperPath: string
  spawn?: SpawnLike
  timeoutMs?: number
}): Promise<boolean | null> {
  const spawnFn = options.spawn ?? defaultSpawn
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  let proc: CaptureProcessLike
  try {
    proc = spawnFn(options.helperPath, ['--probe'])
  } catch {
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    function finish(result: boolean | null): void {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const parser = createCaptureLineParser({
      onPermission: (ok) => {
        proc.kill('SIGTERM')
        finish(ok)
      },
    })
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      finish(null)
    }, timeoutMs)
    // close（stdio 全关）才判定「没拿到结果」：exit 可先于管道数据送达，会抢跑误判。
    proc.on('close', () => finish(null))
    proc.on('error', () => finish(null))
    pipeStdoutLines(proc.stdout, parser)
  })
}

/** 系统设置的「输入监控」面板深链：授权后需重启应用才生效（tap 的建立只在启动期尝试）。 */
export const INPUT_MONITORING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_InputMonitoring'

/** ipcMain.handle 用到的最小面（与 settings/ipc.ts 同形态）。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): unknown
}

/**
 * 设置页读 capture 状态与跳转系统设置的两个通道，缺省值即 @treen/ipc 的单一事实源
 * （channels 注入仅供测试）。状态由装配层闭包供给（通道随时可能崩溃回落，读时现查
 * 而不是注册时快照）。
 */
export function registerHotkeyCaptureIpc(options: {
  ipc: IpcMainLike
  status: () => HotkeyCaptureStatus
  openSystemSettings: () => void
  channels?: { hotkeyCaptureStatus: string; hotkeyCaptureOpenSettings: string }
}): void {
  const channels = options.channels ?? {
    hotkeyCaptureStatus: IPC_CHANNELS.hotkeyCaptureStatus,
    hotkeyCaptureOpenSettings: IPC_CHANNELS.hotkeyCaptureOpenSettings,
  }
  options.ipc.handle(channels.hotkeyCaptureStatus, () => options.status())
  options.ipc.handle(channels.hotkeyCaptureOpenSettings, () => options.openSystemSettings())
}
