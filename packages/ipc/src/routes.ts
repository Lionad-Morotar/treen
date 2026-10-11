/**
 * 渲染站的 HTTP 端点路径与监听地址。
 *
 * 单独成文件、且本文件不引入任何依赖，是因为浏览器侧也要消费这些常量：`@treen/ipc` 的根出口
 * 带着配置自检（依赖 `@treen/shared` 的 env 读取），那条链会碰 `node:fs` 与 `process`，
 * 随客户端包进浏览器会在模块求值期炸掉。路由常量是纯字符串，浏览器侧请走 `@treen/ipc/routes`。
 */

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
 * 改名即断链），前者只在 dev 环境可用、非 dev 一律 404。可用性是纯运行时的门禁而非注册与否
 * ——生产产物的路由表里照样有这几条，404 是请求进来后在 `server/utils/dev-gate.ts` 决定的，
 * 按路由表查「生产为什么 404」会查错方向。
 */
export const RENDER_SITE_DEV_ROUTES = {
  /** POST { image } → { blocks, elapsedMs } */
  ocr: '/api/dev/ocr',
  /** POST { texts } → { translations, gated } */
  translate: '/api/dev/translate',
  /** POST { image, translateText?, translateCharts? } → { blocks, translations, plan, timings, diagnostics } */
  pipeline: '/api/dev/pipeline',
  /** GET → { root, samples }：仓库 zRefs 下可作为回归样本的图清单 */
  samples: '/api/dev/samples',
  /**
   * GET → { name, mime, base64 }：单张样本图的内容。
   *
   * 尾部是具名通配而非 `:name`：样本名是相对 zRefs 的路径（`bug-261010/orig.png`），
   * 单段占位符遇斜杠即不匹配。
   */
  sample: '/api/dev/samples/**:name',
} as const

/**
 * 单张样本图的请求路径。
 *
 * 名字整段编码（含斜杠转 `%2F`）：路由表按 URL 路径分段匹配，把 `/` 写进路径会让请求落到
 * 另一条路由上，服务端收到的名字也会被截掉后半段。
 */
export function renderSiteDevSamplePath(name: string): string {
  return `${RENDER_SITE_DEV_ROUTES.samples}/${encodeURIComponent(name)}`
}

/**
 * 渲染站监听的地址与端口。只绑回环：服务仅供电桌壳层调用，暴露到 LAN 会把本机变成公开渲染端点。
 * 端口固定是为了让壳层能写死基准 URL 而无需运行时发现。
 */
export const RENDER_SITE_HOST = '127.0.0.1'
export const RENDER_SITE_PORT = 5433

/** 渲染站基准 URL：壳层据此拼出 `RENDER_SITE_ROUTES` 里的端点，服务端据此绑定监听地址。 */
export const RENDER_SITE_ORIGIN = `http://${RENDER_SITE_HOST}:${RENDER_SITE_PORT}`
