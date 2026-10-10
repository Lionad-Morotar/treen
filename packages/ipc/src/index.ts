import { readDeepSeekKey, redactSecret } from '@treen/shared'

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

/** 常驻渲染站的 HTTP 端点：mermaid 源码进、SVG 出。路径集中定义，两侧共此一份。 */
export const RENDER_SITE_ROUTES = {
  /** POST { source } → { svg, width, height } 或 { error }；源码不合法时不渲染，报错带原因 */
  render: '/api/render',
  /** GET → { ok: true, service, version }，用于壳层确认渲染站已就绪 */
  health: '/api/health',
} as const

/**
 * 渲染站的开发期端点：上传图片跑 OCR、翻译、图表装配，供 `/dev/pipeline` 调试页消费。
 *
 * 与 `RENDER_SITE_ROUTES` 分开成表是因为两者的可用性契约不同：后者是生产契约（壳层依赖它，
 * 改名即断链），前者三条只在 dev 环境可用、非 dev 一律 404。可用性是纯运行时的门禁而非注册
 * 与否——生产产物的路由表里照样有这三条，404 是请求进来后在 `server/utils/dev-gate.ts` 决定的，
 * 按路由表查「生产为什么 404」会查错方向。
 */
export const RENDER_SITE_DEV_ROUTES = {
  /** POST { image } → { blocks, elapsedMs } */
  ocr: '/api/dev/ocr',
  /** POST { texts } → { translations, gated } */
  translate: '/api/dev/translate',
  /** POST { image, translateText?, translateCharts? } → { blocks, translations, plan, timings, diagnostics } */
  pipeline: '/api/dev/pipeline',
} as const

/**
 * 渲染站监听的地址与端口。只绑回环：服务仅供电桌壳层调用，暴露到 LAN 会把本机变成公开渲染端点。
 * 端口固定是为了让壳层能写死基准 URL 而无需运行时发现。
 */
export const RENDER_SITE_HOST = '127.0.0.1'
export const RENDER_SITE_PORT = 5433

/** 渲染站基准 URL：壳层据此拼出 `RENDER_SITE_ROUTES` 里的端点，服务端据此绑定监听地址。 */
export const RENDER_SITE_ORIGIN = `http://${RENDER_SITE_HOST}:${RENDER_SITE_PORT}`

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
