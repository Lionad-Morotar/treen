import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RENDER_SITE_ROUTES } from '@treen/ipc'
import { ensureRenderSite, type EnsureRenderSiteDeps } from '../src/render-site/resident'

/**
 * 常驻拉起的纯逻辑面：外部站点复用、产物缺失告警、拉起后就绪、超时回收。
 * 健康端点的应答形态用 node:http 临时站模拟，端口经 origin 注入避开固定端口串扰。
 */

const servers: Server[] = []
const children: Array<ReturnType<typeof nodeSpawn>> = []

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function serveHealthOn(port: number): Server {
  const server = createServer((request, response) => {
    if (request.url === RENDER_SITE_ROUTES.health) {
      response.statusCode = 200
      response.end('{"ok":true}')
      return
    }
    response.statusCode = 404
    response.end()
  })
  servers.push(server)
  server.listen(port, '127.0.0.1')
  return server
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close()
  }
  for (const child of children.splice(0)) {
    child.kill()
  }
})

function deps(patch: Partial<EnsureRenderSiteDeps>): EnsureRenderSiteDeps {
  return { appPath: '/nonexistent-app-root', ...patch }
}

describe('ensureRenderSite · 外部站点已在跑', () => {
  it('健康检查通过即复用，不拉起子进程', async () => {
    const port = await freePort()
    const server = serveHealthOn(port)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const spawnImpl = vi.fn()
    const handle = await ensureRenderSite(deps({ origin: `http://127.0.0.1:${port}`, spawnImpl }))
    expect(handle).not.toBeNull()
    expect(spawnImpl).not.toHaveBeenCalled()
  })
})

describe('ensureRenderSite · 拉起常驻站点', () => {
  it('spawn 后轮询到就绪，stop 收掉子进程', async () => {
    const port = await freePort()
    const entry = join(mkdtempSync(join(tmpdir(), 'treen-site-')), 'index.mjs')
    writeFileSync(entry, '// stub entry')
    const kill = vi.fn()
    const exists = vi.fn(() => true)
    const spawnImpl = vi.fn((_entry: string, env: NodeJS.ProcessEnv) => {
      // 模拟「子进程起来后才开始应答」：延迟 400ms 再监听，考验轮询。
      setTimeout(() => serveHealthOn(Number(env.PORT)), 400)
      children.push({ kill } as unknown as ReturnType<typeof nodeSpawn>)
      return { kill } as unknown as ReturnType<typeof nodeSpawn>
    })
    const handle = await ensureRenderSite(
      deps({ origin: `http://127.0.0.1:${port}`, spawnImpl, exists, waitMs: 8_000 }),
    )
    expect(handle).not.toBeNull()
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    handle?.stop()
    expect(kill).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('spawn 后始终不就绪：超时放弃并回收子进程', async () => {
    const port = await freePort()
    const kill = vi.fn()
    const spawnImpl = vi.fn(() => {
      children.push({ kill } as unknown as ReturnType<typeof nodeSpawn>)
      return { kill } as unknown as ReturnType<typeof nodeSpawn>
    })
    const handle = await ensureRenderSite(
      deps({ origin: `http://127.0.0.1:${port}`, spawnImpl, exists: () => true, waitMs: 600 }),
    )
    expect(handle).toBeNull()
    expect(kill).toHaveBeenCalledTimes(1)
  })
})

describe('ensureRenderSite · 产物缺失', () => {
  it('不 spawn，告警给出构建指引', async () => {
    const spawnImpl = vi.fn()
    const warns: string[] = []
    const handle = await ensureRenderSite(
      deps({ spawnImpl, logger: { warn: (m) => warns.push(m), info: () => {} } }),
    )
    expect(handle).toBeNull()
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(warns.join('\n')).toContain('build:render-site')
  })
})
