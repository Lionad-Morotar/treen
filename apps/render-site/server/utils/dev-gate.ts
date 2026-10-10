/**
 * `/api/dev/*` 的 dev-only 门禁。
 *
 * 这条路由下的端点能吃外部输入（上传图片）并触发计费的外部调用（OCR、翻译），生产产物里绝不能留下它们。
 * 防线是两道且互相独立：路由注册来自 `nuxt.config.ts` 的显式清单，运行时再由这里判一次环境。
 *
 * 判定做成可注入是因为 `import.meta.dev` 在构建期就被替换成字面量——同一份源码在 dev server 与
 * 生产产物里是两个互不可推导的值，单测要覆盖两种分支只能在运行时换掉判定来源，而不是去 mock
 * 一个打包常量。生产路径上没人调用注入口，开销为零。
 */

/** dev 判定来源。 */
export type DevGate = () => boolean

let override: boolean | null = null

/**
 * 未注入时的判定：`import.meta.dev` 由 Nitro 在构建期注入，拿不到（纯 Node 直跑、单测）时
 * 退回 NODE_ENV——Nitro 的生产产物会把 NODE_ENV 置成 production，dev server 不会。
 */
function runtimeDevGate(): boolean {
  const dev = (import.meta as { dev?: boolean }).dev
  if (typeof dev === 'boolean') {
    return dev
  }
  return process.env.NODE_ENV !== 'production'
}

/** 当前是否为可暴露调试端点的环境。 */
export function isDevEnvironment(): boolean {
  return override ?? runtimeDevGate()
}

/**
 * 覆盖 dev 判定；传 null 还原为运行时判定。
 *
 * 只供测试使用：进程级可变状态在服务端是共享的，生产代码拿它当开关会让一次注入影响全部请求。
 */
export function setDevEnvironmentOverride(value: boolean | null): void {
  override = value
}

/** 请求体校验与依赖缺失的可操作错误；`statusCode` 直接落到 HTTP 响应上。 */
export class DevRouteError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'DevRouteError'
    this.statusCode = statusCode
  }
}

/**
 * 端点结果。
 *
 * `gated` 那一支不携带响应体：它的响应必须由 handler 交给 Nitro 的默认错误处理器去渲染，
 * 本模块刻意不产出任何文本（见 devGateNotFound）。其余分支的 body 直接落到响应上。
 */
export type DevRouteOutcome =
  | { gated: true; statusCode: 404 }
  | { gated: false; statusCode: number; body: unknown }

/** 由 handler 转成 Nitro 默认 404 的错误输入；这里不引 h3，本模块才能被单测直接装载。 */
export interface DevGateNotFound {
  statusCode: 404
  statusMessage: string
}

/**
 * 门禁未通过时该抛什么错（handler 层用 `createError` 包一层）。
 *
 * 措辞刻意与 h3 未命中路由时抛的错一致（`createRouter` 的 matchHandler）：这些端点在产物里
 * 是注册进路由表的，只要响应体里说一句「该端点仅在开发环境可用」，扫描方就能把「这里有一条
 * dev-only 调试接口」认出来——选 404 是为了少暴露信息，响应体却原样交出去等于把门禁作废。
 */
export function devGateNotFound(path: string): DevGateNotFound {
  // h3 匹配路由时会掐掉 query，这里同步掐掉，否则带 query 的请求又是一种措辞。
  const clean = (path.split('?', 1)[0] ?? '') || '/'
  return { statusCode: 404, statusMessage: `Cannot find any route matching ${clean}.` }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return String(error)
}

/**
 * 执行一个 dev 端点的主体：先过门禁，再统一把异常翻成 `{ error }` 形态。
 *
 * 异常到状态码的收口放在这里而不是各 handler：各条端点对「参数不对」「依赖没配」「链路炸了」
 * 的处置完全一致，散开写会各自漂移。形态与既有 handler 一致（见 render.ts）——不用
 * createError，因为 Nitro 的错误序列化在生产会抹掉 message，且字段名与本项目契约不符。
 * 唯一例外是门禁未通过：那里要的正是「Nitro 默认渲染出的那条 404」，故由 handler 转交
 * createError（见 devGateNotFound）。
 */
export async function runDevRoute(run: () => Promise<unknown>): Promise<DevRouteOutcome> {
  if (!isDevEnvironment()) {
    return { gated: true, statusCode: 404 }
  }
  try {
    return { gated: false, statusCode: 200, body: await run() }
  } catch (error) {
    if (error instanceof DevRouteError) {
      return { gated: false, statusCode: error.statusCode, body: { error: error.message } }
    }
    return { gated: false, statusCode: 500, body: { error: messageOf(error) } }
  }
}
