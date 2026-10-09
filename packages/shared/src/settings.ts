import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 用户设置的模型与持久化。
 *
 * 与 env.ts 同属「共享配置层」，但读写的是用户可改的运行时配置而非部署期密钥，故形态有两条不同：
 * 一是落点由调用方注入（Electron 侧给 `app.getPath('userData')`，这里不拼 home 目录——
 * 自己拼 home 会在打包态与多用户机上落到错的地方）；二是**坏值不致命**，逐字段回落到默认，
 * 一个坏字段不该让整个设置读不出来。
 *
 * 默认值分两类来源：本模块只拥有开关类默认（是产品口径），快捷键默认属于热键注册域，
 * 由调用方经 `defaults` 注入——这避免共享包反向依赖桌面壳的常量表，也让「默认键位」只有一个字面量。
 */

/** 翻译文本开关的默认值：默认开（验收口径）。关掉只影响译文覆盖，不影响图表。 */
export const DEFAULT_TRANSLATE_TEXT = true

/** 翻译图表开关的默认值：默认开（验收口径）。关掉只影响 mermaid 图的提取与渲染。 */
export const DEFAULT_TRANSLATE_CHARTS = true

/** 图内节点文案翻译开关的默认值：默认开（用户拍板「默认翻译」）。关掉时图用识别到的原文源码渲染。 */
export const DEFAULT_TRANSLATE_NODE_LABELS = true

/** 设置文件名。落在调用方给出的配置目录下（桌面壳传 `app.getPath('userData')`）。 */
export const SETTINGS_FILENAME = 'settings.json'

export interface TreenSettings {
  /** 进入冻结态的全局热键；形态是 Electron accelerator 字符串 */
  freezeAccelerator: string
  /** 是否覆盖译文（关掉仍可能因图表开关而运行 OCR） */
  translateText: boolean
  /** 是否提取并覆盖 mermaid 图表 */
  translateCharts: boolean
  /** 是否翻译图内节点文案（失败自动回落原文，图不会因此消失） */
  translateNodeLabels: boolean
}

/** 设置文件路径：配置目录 + 固定文件名。 */
export function settingsFilePath(configDir: string): string {
  return join(configDir, SETTINGS_FILENAME)
}

/** 只用到 warn 的窄接口：读设置不该逼调用方持有完整 Logger。 */
export interface SettingsLogger {
  warn(message: string): void
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 字符串字段的归一。空串与纯空白视为无效：一个空的 accelerator 注册不上，
 * 留在磁盘里只会让下次启动静默丢掉热键，不如当场回落。
 */
function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/**
 * 把任意来源的对象归一成合法设置：只认默认值对象声明过的键，逐字段做类型校验，
 * 不符即回落到该字段的默认值。未声明的键直接丢弃（写入端因此天然拒收未知键）。
 *
 * 逐字段而非整体回落是刻意的：磁盘上的设置是用户手改过或旧版本写的，一个被改坏的布尔
 * 不该把另一个本来正常的字段一起打回默认。
 */
export function normalizeSettings(raw: unknown, defaults: TreenSettings): TreenSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  return {
    freezeAccelerator: readString(source.freezeAccelerator, defaults.freezeAccelerator),
    translateText: readBoolean(source.translateText, defaults.translateText),
    translateCharts: readBoolean(source.translateCharts, defaults.translateCharts),
    translateNodeLabels: readBoolean(source.translateNodeLabels, defaults.translateNodeLabels),
  }
}

export interface ReadSettingsOptions {
  /** 设置文件绝对路径 */
  file: string
  /** 逐字段回落用的默认值 */
  defaults: TreenSettings
  logger?: SettingsLogger
}

/**
 * 读设置。文件不存在 → 全部默认（首次启动的正常态）。
 * 文件存在但读不出来（权限不足、路径是目录）→ 抛带路径上下文的错：那是配置损坏，
 * 静默按默认处理会让用户以为自己的设置丢了。
 * 文件存在但不是合法 JSON → 全部默认并记一行 warn：整体损坏没有可保留的字段。
 */
export function readSettings(options: ReadSettingsOptions): TreenSettings {
  const { file, defaults } = options
  if (!existsSync(file)) {
    return { ...defaults }
  }
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取设置文件 ${file}：${reason}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    options.logger?.warn(`设置文件 ${file} 不是合法 JSON，本次按默认值处理：${reason}`)
    return { ...defaults }
  }
  return normalizeSettings(parsed, defaults)
}

export interface WriteSettingsOptions {
  file: string
  /** 待写入的值；形状不定（可能来自渲染层），写入前统一归一 */
  values: unknown
  defaults: TreenSettings
}

/**
 * 写设置：先归一再落盘，返回值即实际写入的内容。
 *
 * 归一而非直接序列化传入值：写端是渲染层跨越进程边界来的数据，不校验就把未知键与错类型
 * 落进磁盘，读端虽有回落兜底但会把坏数据固化下来。写端拒收是更早的一道闸。
 *
 * 用「临时文件 + rename」而非直接覆盖：写一半被杀会留下半个 JSON，而 rename 在多数文件系统上
 * 是原子的，读端要么看到旧的完整文件、要么看到新的完整文件。目录不存在时顺手建出来。
 */
export function writeSettings(options: WriteSettingsOptions): TreenSettings {
  const { file } = options
  const next = normalizeSettings(options.values, options.defaults)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return next
}
