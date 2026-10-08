import { readDeepSeekKey, redactSecret } from '@treen/shared'

/** 壳与渲染端/主进程之间使用的稳定通道名，集中定义以防字符串漂移。 */
export const IPC_CHANNELS = {
  freezeScreen: 'treen:freeze-screen',
  translateSelection: 'treen:translate-selection',
  renderMermaid: 'treen:render-mermaid',
  captureComposite: 'treen:capture-composite',
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
