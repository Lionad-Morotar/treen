import { spawn } from 'node:child_process'

/**
 * 热键 capture 通道：spawn 原生助手（CGEvent tap）在系统派发之前吞掉已注册键位。
 *
 * globalShortcut 在 macOS 不吞事件——按键照旧派发给前台应用（VS Code 的同键位快捷键会被
 * 一并触发），要吞键必须经助手的过滤型 tap，代价是「输入监控」授权。本模块把 spawn、
 * 行协议解析、崩溃重启与退出收口集中在一处，全部依赖（进程创建、真实二进制路径）可注入，
 * 纯 Node 可测；真实装配在 main。
 *
 * 回退语义归调用方（ShortcutManager / 装配层）：spawn 返回 null、available() 变 false、
 * probe 得 false，都意味着「走 globalShortcut，行为等同无本模块」。
 */

/** accelerator → 键表条目（tap 侧命中判定用的修饰键与单字符）。 */
export interface ParsedHotkey {
  accel: string
  mods: { cmd: boolean; shift: boolean; ctrl: boolean; opt: boolean }
  key: string
}

/**
 * 解析 Electron accelerator。只接受「修饰键 + 单个字母/数字」形态：tap 侧靠事件 unicode
 * 字符命中，功能键（Escape、F1…）没有可靠的字符判定，天然不在 capture 能力内——
 * 这类键位由调用方落回 globalShortcut，而不是在 tap 里猜。
 */
export function parseAccelerator(accel: string): ParsedHotkey | null {
  const parts = accel.split('+').map((part) => part.trim()).filter((part) => part.length > 0)
  if (parts.length === 0) {
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
    modifiers.has('cmd')
  const controlLike = modifiers.has('control') || modifiers.has('ctrl')
  // CommandOrControl 按当前平台展开：macOS 是 Command，其它平台是 Control（Windows 留路时改这里）。
  const cmd = process.platform === 'darwin' ? commandLike : controlLike
  const ctrl = process.platform === 'darwin' ? controlLike : commandLike
  return {
    accel,
    mods: {
      cmd,
      ctrl,
      shift: modifiers.has('shift'),
      opt: modifiers.has('alt') || modifiers.has('option') || modifiers.has('opt'),
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
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export type SpawnLike = (command: string, args: readonly string[]) => CaptureProcessLike

export interface HotkeyCaptureLogger {
  info(message: string): void
  warn(message: string): void
}

/** capture 通道当前状态，设置页据此区分「吞键已生效」与「监听模式」。 */
export interface HotkeyCaptureStatus {
  /** 助手在岗且 tap 生效（崩溃重启失败后为 false） */
  active: boolean
  /** 输入监控授权态（probe 结果；通道不存在时为 false） */
  authorized: boolean
}

/** 交给 ShortcutManager 的 capture 通道面：注册面变化时整表同步，命中与失效异步回报。 */
export interface HotkeyCaptureChannel {
  /** 整表替换助手键位表；助手的 set 语义即整表替换，热更新不重启进程。 */
  setHotkeys(accelerators: readonly string[]): void
  onHit(handler: (accelerator: string) => void): void
  /** 通道失效（崩溃重启失败）：此后 available 为 false，调用方应把键位迁回 globalShortcut。 */
  onUnavailable(handler: (reason: string) => void): void
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

interface ResolvedOptions {
  helperPath: string
  timeoutMs: number
  spawn: SpawnLike
  logger?: HotkeyCaptureLogger
}

/**
 * 等待一个刚 spawn 的助手报 READY 或失败。READY 前的 TAP-ERROR、异常退出、spawn error、
 * 超时都算启动失败；返回 false 时调用方负责收掉进程。
 */
function awaitReady(proc: CaptureProcessLike, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let tapError: string | null = null
    let resolved = false
    const parser = createCaptureLineParser({
      onReady: () => finish(true),
      onTapError: (reason) => {
        tapError = reason || 'unknown'
        finish(false)
      },
    })
    function finish(ok: boolean): void {
      if (resolved) {
        return
      }
      resolved = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      finish(false)
    }, timeoutMs)
    proc.on('exit', () => finish(false))
    proc.on('error', () => finish(false))
    pipeStdoutLines(proc.stdout, (line) => {
      parser(line)
      // READY 处理器已直接 finish；这里兜「一行都没来进程就挂了」之外的 TAP-ERROR 形态。
      if (tapError !== null) {
        finish(false)
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
    // stdin 已随进程退出关闭：exit 事件会接手崩溃处置
  }
}

/**
 * spawn 助手并建立通道。返回 null 的全部形态：二进制缺失（spawn ENOENT）、未授权
 * （TAP-ERROR permission-denied）、启动超时——调用方一律回退 globalShortcut。
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
  if (!(await awaitReady(proc, resolved.timeoutMs))) {
    try {
      proc.kill('SIGTERM')
    } catch {
      // 进程已自行退出，无需处理
    }
    resolved.logger?.warn('热键 capture 助手启动失败，回退到 globalShortcut 监听模式')
    return null
  }

  let disposed = false
  let active = true
  let hitHandler: ((accelerator: string) => void) | null = null
  let unavailableHandler: ((reason: string) => void) | null = null
  let currentHotkeys: readonly string[] = options.hotkeys
  const runtimeParser = createCaptureLineParser({
    onHit: (accel) => hitHandler?.(accel),
    onTapRebuilt: () => resolved.logger?.info('热键 capture tap 被系统禁用后已重建'),
  })

  function attachRuntime(target: CaptureProcessLike): void {
    pipeStdoutLines(target.stdout, runtimeParser)
    target.on('exit', (code) => {
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
    // 助手崩溃只自动重启一次：反复重启大概率是权限被撤或二进制损坏，重启风暴只会反复
    // 吞掉启动期按键。重启失败即落 unavailable，ShortcutManager 把键位迁回 globalShortcut
    // ——快捷键从不静默消失，只是退回监听模式。
    active = false
    setTimeout(() => {
      if (disposed) {
        return
      }
      let next: CaptureProcessLike
      try {
        next = resolved.spawn(resolved.helperPath, buildArgs(currentHotkeys))
      } catch {
        unavailableHandler?.(reason)
        return
      }
      void awaitReady(next, resolved.timeoutMs).then((ok) => {
        if (disposed) {
          return
        }
        if (!ok) {
          try {
            next.kill('SIGTERM')
          } catch {
            // 进程已自行退出
          }
          unavailableHandler?.(reason)
          return
        }
        active = true
        proc = next
        attachRuntime(next)
        sendSet(next, currentHotkeys)
        resolved.logger?.info('热键 capture 助手已重启恢复')
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
    available: () => active && !disposed,
    status: () => ({ active: active && !disposed, authorized: true }),
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      try {
        proc.stdin?.end()
      } catch {
        // stdin 已随进程退出关闭
      }
      try {
        proc.kill('SIGTERM')
      } catch {
        // 进程已自行退出
      }
    },
  }
}

function defaultSpawn(command: string, args: readonly string[]): CaptureProcessLike {
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
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
    proc.on('exit', () => finish(null))
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

/** 两个 IPC 通道名；缺省值与 @treen/ipc 的 IPC_CHANNELS 字面量重复，由测试对拍防漂移。 */
export interface HotkeyCaptureIpcChannels {
  hotkeyCaptureStatus: string
  hotkeyCaptureOpenSettings: string
}

/**
 * 设置页读 capture 状态与跳转系统设置的两个通道。状态由装配层闭包供给（通道随时可能
 * 崩溃回落，读时现查而不是注册时快照）。
 */
export function registerHotkeyCaptureIpc(options: {
  ipc: IpcMainLike
  status: () => HotkeyCaptureStatus
  openSystemSettings: () => void
  channels?: HotkeyCaptureIpcChannels
}): void {
  const channels = options.channels ?? {
    hotkeyCaptureStatus: 'treen:hotkey-capture-status',
    hotkeyCaptureOpenSettings: 'treen:hotkey-capture-open-settings',
  }
  options.ipc.handle(channels.hotkeyCaptureStatus, () => options.status())
  options.ipc.handle(channels.hotkeyCaptureOpenSettings, () => options.openSystemSettings())
}
