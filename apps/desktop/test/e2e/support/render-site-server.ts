import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RENDER_SITE_ROUTES } from '@treen/ipc'

/**
 * 集成验收用的「真渲染站」生命周期：起一个真实的 Nuxt 渲染站进程，健康探针就绪后交给用例，
 * 收尾杀净子树。
 *
 * 为什么要真起一个进程而不是进程内 import renderMermaidSvg：壳层消费渲染站走的是 HTTP
 * （`createRenderSiteClient`），进程内直调绕过的是整条 HTTP 边界——状态码、错误体形态、
 * 序列化这些恰恰是生产链路的一部分。渲染站自身是本地进程，不依赖外网，起它就与「离线即红的
 * 探针」不同：这里是产物确定性，不是环境依赖。
 *
 * 端口与生产端口（固定 5433）错开，免得撞上开发机上正在跑的渲染站；若目标 origin 上已有
 * 同标识的渲染站在跑（本机常驻），直接复用而不另起，此时 stop 是空操作。
 */

const PACKAGE_DIR = fileURLToPath(new URL('../../../../render-site/', import.meta.url))
const NUXT_BIN = fileURLToPath(
  new URL('../../../../render-site/node_modules/nuxt/bin/nuxt.mjs', import.meta.url),
)

/** 测试用渲染站端口：与生产 5433 错开。 */
export const TEST_RENDER_SITE_PORT = 5434

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  stepMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await sleep(stepMs)
  }
}

/** 渲染站就绪探针：确认占住这个端口的是我们要的那份服务，而不是别的进程。 */
async function isRenderSiteUp(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}${RENDER_SITE_ROUTES.health}`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) {
      return false
    }
    const payload = (await response.json()) as { ok?: unknown; service?: unknown }
    return payload.ok === true && payload.service === 'treen-render-site'
  } catch {
    return false
  }
}

export interface RunningRenderSite {
  origin: string
  stop(): Promise<void>
}

export interface StartRenderSiteOptions {
  port?: number
  /** 冷启动编译可能耗时，给足上限；超时即带日志抛错。 */
  timeoutMs?: number
}

export async function startRenderSite(options: StartRenderSiteOptions = {}): Promise<RunningRenderSite> {
  const port = options.port ?? TEST_RENDER_SITE_PORT
  const origin = `http://127.0.0.1:${port}`

  if (await isRenderSiteUp(origin)) {
    return { origin, stop: async () => {} }
  }

  const logs: string[] = []
  const child: ChildProcess = spawn(
    process.execPath,
    [NUXT_BIN, 'dev', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: PACKAGE_DIR,
      // NUXT_IGNORE_LOCK：@nuxt/cli 的 dev lock 按项目目录共享，开发机上跑着别的实例时会拦住
      // 第二个实例；测试起的这份是独立端口，理应绕开那把锁。
      env: { ...process.env, NUXT_IGNORE_LOCK: '1' },
      // detached 让它自成进程组，便于按组收尾（nuxt dev 会派生 nitro 子进程）。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()))

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => resolve())
  })

  /**
   * 杀净：两条通道都打。直接杀包装进程用 spawn 存下的 pid，最可靠；按进程组杀覆盖 nuxt 派生的
   * nitro 子进程——只杀包装进程会留下孤儿继续占端口，只按组杀则在平台未把 detached 子进程设为
   * 组长时会漏。任一通道失效由另一条兜住。
   */
  const killTree = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal)
    } catch {
      // 已退出。
    }
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal)
      } catch {
        // 进程组不存在（平台未设为组长）或已空，忽略。
      }
    }
  }

  const exitGuard = (): void => killTree('SIGKILL')
  process.on('exit', exitGuard)

  const stop = async (): Promise<void> => {
    process.off('exit', exitGuard)
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    killTree('SIGTERM')
    const graceful = await Promise.race([exited.then(() => true), sleep(6000).then(() => false)])
    if (!graceful) {
      killTree('SIGKILL')
    }
    // 等退出事件落地再返回：afterAll 先于进程消亡返回，会让紧随其后的重跑或收尾核对撞上「端口仍占用」。
    await Promise.race([exited, sleep(3000)])
  }

  const ready = await waitUntil(() => isRenderSiteUp(origin), options.timeoutMs ?? 120_000)
  if (!ready) {
    await stop()
    throw new Error(`渲染站起服超时（${origin}）：\n${logs.join('').slice(-2000)}`)
  }

  return { origin, stop }
}
