import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { RENDER_SITE_HOST, RENDER_SITE_PORT, RENDER_SITE_ROUTES } from '@treen/ipc'

/**
 * 渲染站的常驻拉起：壳层启动时确保渲染站有人应答。
 *
 * 图表是否渲染由渲染站裁决（校验即渲染），壳层只带 HTTP 客户端——但站点本体从没人拉起过，
 * 真机上每次图表渲染都静默失败，这是「跟随进程常驻」需求的交付缺口。这里收口三步：
 * 先健康检查（外部已在跑的站点优先，不抢开发者手动起的站），不通再以 Electron 自带的
 * Node 运行时拉起构建产物，起不来（产物缺失、端口被占、启动崩溃）就告警并放弃，
 * 图表退化为「渲染失败跳过」的既有行为，文本翻译不受影响。
 */

/** 拉起结果：handle 供退出钩子收掉子进程；null 表示没拉起来（原因已进日志）。 */
export interface ResidentSiteHandle {
  stop(): void
}

export interface ResidentSiteLogger {
  info(message: string): void
  warn(message: string): void
}

export interface EnsureRenderSiteDeps {
  /** 壳层应用根（electron 的 app.getAppPath()），渲染站构建产物按兄弟目录解析。 */
  appPath: string
  /** 健康检查与就绪轮询的基地址；测试注入以避开固定端口。 */
  origin?: string
  fetchImpl?: typeof fetch
  /** 拉起子进程的注入点；缺省用 Electron 主执行档 + ELECTRON_RUN_AS_NODE。 */
  spawnImpl?: (entry: string, env: NodeJS.ProcessEnv) => ChildProcess
  /** 产物存在性检查的注入点；缺省 existsSync。 */
  exists?: (path: string) => boolean
  /** 就绪等待总时长（毫秒）。 */
  waitMs?: number
  logger?: ResidentSiteLogger
}

/** 轮询间隔：渲染站冷启动在百毫秒量级，密一点没有收益。 */
const POLL_INTERVAL_MS = 250

/** 构建产物的候选落点：dev 布局（apps/desktop 的兄弟目录）与打包布局（应用根下）。 */
function siteEntryCandidates(appPath: string): string[] {
  return [
    join(appPath, '../render-site/.output/server/index.mjs'),
    join(appPath, 'render-site/.output/server/index.mjs'),
  ]
}

async function healthy(origin: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${origin}${RENDER_SITE_ROUTES.health}`, {
      signal: AbortSignal.timeout(800),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 确保渲染站在跑。返回 handle 供退出时收掉子进程；外部站点在跑时 handle 不持有子进程
 * （stop 只收自己拉起的），拉起失败返回 null——调用方继续跑，图表按既有失败路径退化。
 */
export async function ensureRenderSite(deps: EnsureRenderSiteDeps): Promise<ResidentSiteHandle | null> {
  const origin = deps.origin ?? `http://${RENDER_SITE_HOST}:${RENDER_SITE_PORT}`
  // 子进程的监听端口与主机从 origin 派生而非另写常量：测试注入临时端口时子进程也随之，
  // 生产形态不变（origin 缺省即契约常量）。
  const originUrl = new URL(origin)
  const childPort = originUrl.port || String(RENDER_SITE_PORT)
  const childHost = originUrl.hostname
  const fetchImpl = deps.fetchImpl ?? fetch
  const exists = deps.exists ?? existsSync
  const logger = deps.logger

  if (await healthy(origin, fetchImpl)) {
    logger?.info('渲染站已在运行（外部拉起），壳层直接复用')
    return { stop: () => {} }
  }

  const entry = siteEntryCandidates(deps.appPath).find((candidate) => exists(candidate))
  if (entry === undefined) {
    logger?.warn(
      '渲染站构建产物缺失，图表覆盖不可用：先跑 pnpm build:render-site 生成 apps/render-site/.output',
    )
    return null
  }

  const spawnImpl: (entry: string, env: NodeJS.ProcessEnv) => ChildProcess =
    deps.spawnImpl ??
    ((spawnEntry, env) =>
      spawn(process.execPath, [spawnEntry], { env, stdio: 'ignore', detached: false }))
  const child = spawnImpl(entry, { ...process.env, PORT: childPort, HOST: childHost })

  const deadline = Date.now() + (deps.waitMs ?? 10_000)
  while (Date.now() < deadline) {
    if (await healthy(origin, fetchImpl)) {
      logger?.info('渲染站已由壳层拉起（常驻）')
      return {
        stop: () => {
          child.kill()
        },
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  logger?.warn('渲染站拉起后未在时限内就绪，图表覆盖不可用')
  child.kill()
  return null
}
