import { readDeepSeekKey, redactSecret } from '@treen/shared'

export const DESKTOP_APP_NAME = 'Treen'

export interface StartupDescriptor {
  appName: string
  deepSeekConfigured: boolean
  /** 可直接写入日志的一行摘要，密钥已经过脱敏。 */
  logLine: string
}

export interface StartupOptions {
  envFile?: string
  env?: NodeJS.ProcessEnv
}

/** 组装启动自检信息；与 Electron 运行时解耦，便于纯 Node 下测试。 */
export function describeStartup(options: StartupOptions = {}): StartupDescriptor {
  const key = readDeepSeekKey(options)
  const summary = key === undefined ? '未配置' : redactSecret(key)
  return {
    appName: DESKTOP_APP_NAME,
    deepSeekConfigured: key !== undefined,
    logLine: `${DESKTOP_APP_NAME} 启动 · DeepSeek ${summary}`,
  }
}
