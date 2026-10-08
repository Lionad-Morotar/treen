import { inspect } from 'node:util'

/** DeepSeek 风格密钥（sk- 前缀 + 足够长度的字符集）。 */
export const SECRET_TOKEN_PATTERN = /sk-[A-Za-z0-9]{6,}/g

const SEED_HEAD = 6
const SEED_TAIL = 4

/**
 * 掩码单个密钥：保留可辨识前缀与末四位，中段以省略号代替。
 * 保留末四位是为了排障时确认「读到的是哪把钥匙」，同时中段不可反推。
 * 过短的值整体掩码，避免「前缀即全部」时反而泄露。
 */
export function redactSecret(secret: string): string {
  const value = secret.trim()
  if (value.length <= SEED_HEAD + SEED_TAIL) {
    return '***'
  }
  return `${value.slice(0, SEED_HEAD)}…${value.slice(-SEED_TAIL)}`
}

/** 在自由文本中定位并掩码所有密钥 token。 */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_TOKEN_PATTERN, (match) => redactSecret(match))
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogSink {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface Logger extends LogSink {
  child(scope: string): Logger
}

function redactArg(arg: unknown): unknown {
  if (typeof arg === 'string') {
    return redactSecrets(arg)
  }
  if (arg instanceof Error) {
    return redactSecrets(arg.message)
  }
  if (typeof arg === 'object' && arg !== null) {
    try {
      return redactSecrets(JSON.stringify(arg))
    } catch {
      // 循环引用等让 JSON.stringify 抛错：降级到 inspect（可安全展开循环）后整体脱敏。
      // 不能在此原样返回——兜底分支若把未脱敏对象交给 sink，脱敏防线就被绕过。
      return redactSecrets(inspect(arg, { depth: 4, breakLength: Infinity }))
    }
  }
  return arg
}

/**
 * 创建带作用域前缀的 logger，所有出口统一过脱敏。
 * 脱敏放在 logger 而非调用点：调用点遗忘一次就泄露一次，收口在此是单点防线。
 */
export function createLogger(scope = 'treen', sink: LogSink = console): Logger {
  const emit = (level: LogLevel, args: unknown[]): void => {
    sink[level](`[${scope}]`, ...args.map(redactArg))
  }
  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    child: (childScope) => createLogger(`${scope}:${childScope}`, sink),
  }
}
