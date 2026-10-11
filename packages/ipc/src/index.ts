import { readDeepSeekKey, redactSecret } from '@treen/shared'

// 路由常量另立无依赖模块（浏览器侧也消费），此处原样转出以保持既有导入路径可用。
export * from './routes'

/**
 * Electron 进程间的稳定通道名，集中定义以防字符串漂移。
 *
 * 只收真正走 `ipcMain.handle` / `ipcRenderer.invoke` 的通道。渲染站是独立进程的 HTTP 服务，
 * 它的接口不属于这里：约定见 `RENDER_SITE_ROUTES`。两者混在一张表里会让实现者误判传输方式。
 */
export const IPC_CHANNELS = {
  freezeScreen: 'treen:freeze-screen',
  translateSelection: 'treen:translate-selection',
  captureComposite: 'treen:capture-composite',
  /** 读当前用户设置（设置窗 → 主进程） */
  settingsGet: 'treen:settings-get',
  /** 以补丁写回用户设置，返回落盘后的完整设置（设置窗 → 主进程） */
  settingsSet: 'treen:settings-set',
  /** 读热键 capture 状态（吞键是否生效、是否已授权）（设置窗 → 主进程） */
  hotkeyCaptureStatus: 'treen:hotkey-capture-status',
  /** 打开系统设置的「输入监控」面板（设置窗 → 主进程） */
  hotkeyCaptureOpenSettings: 'treen:hotkey-capture-open-settings',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

export interface SharedConfigProbe {
  configured: boolean
  redactedKey: string | null
}

export interface ProbeOptions {
  envFile?: string
  env?: NodeJS.ProcessEnv
}

/**
 * 配置底座自检：共享层能取到 DeepSeek key，即证明 IPC 侧对 @treen/shared 的依赖链已打通。
 * 返回脱敏后的密钥摘要而非原值，调用方可直接安全地写入日志。
 */
export function probeSharedConfig(options: ProbeOptions = {}): SharedConfigProbe {
  const key = readDeepSeekKey(options)
  return {
    configured: key !== undefined,
    redactedKey: key === undefined ? null : redactSecret(key),
  }
}
