import {
  DEFAULT_TRANSLATE_CHARTS,
  DEFAULT_TRANSLATE_TEXT,
  normalizeSettings,
  readSettings,
  settingsFilePath,
  writeSettings,
  type SettingsLogger,
  type TreenSettings,
} from '@treen/shared'
import { DEFAULT_FREEZE_ACCELERATOR } from '../freeze/window-options'

/**
 * 桌面侧的设置存储：把共享层的纯读写逻辑挂到一个具体文件上（用户配置目录下的 settings.json）。
 *
 * 每次读都落盘（不缓存）：设置要「改完即生效」，而生效点分散在触发热键与每次翻译触发上，
 * 缓存会引入一层「什么时候失效」的隐式约定——文件很小，直接读的代价远低于一处失同步的代价。
 *
 * 本模块不含 Electron 依赖，配置目录由调用方注入，因此可在纯 Node 下被单测覆盖；
 * 真实目录（`app.getPath('userData')`）在 main 装配时给出。
 */

/**
 * 各字段的默认值：开关类是产品口径（共享层给出），热键默认值归热键注册域，
 * 直接取那里的常量，避免同一键位在两处各写一份。
 */
export const SETTINGS_DEFAULTS: TreenSettings = {
  freezeAccelerator: DEFAULT_FREEZE_ACCELERATOR,
  translateText: DEFAULT_TRANSLATE_TEXT,
  translateCharts: DEFAULT_TRANSLATE_CHARTS,
}

export interface SettingsStore {
  /** 读当前设置；文件缺失或损坏时按默认回落（见共享层 readSettings） */
  read(): TreenSettings
  /** 以补丁合并当前设置并落盘，返回落盘后的完整设置 */
  save(patch: unknown): TreenSettings
}

export interface SettingsStoreOptions {
  /** 用户配置目录（Electron 侧为 app.getPath('userData')） */
  userDataDir: string
  /** 覆盖默认值（测试与将来扩字段用） */
  defaults?: TreenSettings
  logger?: SettingsLogger
  /**
   * 设置文件存在却读不出来时的回调（权限不足、被同名目录顶替）。
   *
   * 共享层刻意抛错以拒绝静默，本层是决定「怎么让用户看见」的地方：读回默认值让应用继续可用，
   * 同时把失败交出去，由装配层弹一次可见提示。回调每次读失败都会触发（读不缓存），
   * 去重是调用方的事。
   */
  onReadFailure?: (error: Error) => void
}

export function createSettingsStore(options: SettingsStoreOptions): SettingsStore {
  const defaults = options.defaults ?? SETTINGS_DEFAULTS
  const file = settingsFilePath(options.userDataDir)
  const load = (): TreenSettings => {
    try {
      return readSettings({ file, defaults, logger: options.logger })
    } catch (error) {
      // 设置是「读不到就退默认值」的柔性配置，坏一个文件不该让整个应用起不来；
      // 但每一次回落都要出声，否则用户会以为自己改的设置被吃了。
      const failure = error instanceof Error ? error : new Error(String(error))
      options.logger?.warn(`设置读取失败，本次按默认值处理：${failure.message}`)
      options.onReadFailure?.(failure)
      return { ...defaults }
    }
  }

  return {
    read: load,
    save: (patch) => {
      // 先读当前值再合并：补丁只带「这次改了什么」，缺的字段沿用磁盘现状而非默认，
      // 否则改一个开关会把另一个字段悄悄打回默认。
      //
      // 归一以「当前值」为默认而非产品默认：补丁里类型不符的字段同样必须回落到磁盘现状，
      // 否则一个发错类型的控件就能把另一个正常字段打回出厂值，与上面那条是同一种代价。
      const current = load()
      const source = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>
      return writeSettings({ file, values: { ...current, ...normalizeSettings(source, current) }, defaults })
    },
  }
}
