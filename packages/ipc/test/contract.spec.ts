import { describe, expect, it } from 'vitest'
import {
  IPC_CHANNELS,
  RENDER_SITE_HOST,
  RENDER_SITE_ORIGIN,
  RENDER_SITE_PORT,
  RENDER_SITE_ROUTES,
  probeSharedConfig,
} from '../src/index'

const SAMPLE_KEY = 'sk-4fa26a19a6684c6bb5cdc30800ac0e52'

describe('ipc contract', () => {
  it('exposes stable channel names', () => {
    expect(Object.values(IPC_CHANNELS)).toEqual([
      'treen:freeze-screen',
      'treen:translate-selection',
      'treen:capture-composite',
    ])
  })

  it('keeps the render site routes out of the ipc channel table', () => {
    // 渲染站是独立进程的 HTTP 服务，不是 Electron IPC 通道。混进同一张表会让实现者误走 ipcRenderer.invoke。
    expect(Object.values(IPC_CHANNELS)).not.toContain('treen:render-mermaid')
    expect(RENDER_SITE_ROUTES.render).toBe('/api/render')
    expect(RENDER_SITE_ROUTES.health).toBe('/api/health')
  })

  it('exposes a loopback-only render site base url built from the shared port', () => {
    // 端口漂移会让覆盖渲染整链静默失败（壳层连不上站，报错却与渲染无关），故端口与基准 URL 收紧在此。
    expect(RENDER_SITE_PORT).toBe(5433)
    expect(RENDER_SITE_HOST).toBe('127.0.0.1')
    expect(RENDER_SITE_ORIGIN).toBe('http://127.0.0.1:5433')
  })
})

describe('probeSharedConfig', () => {
  it('reports unconfigured when no key source is available', () => {
    expect(probeSharedConfig({ env: {}, envFile: '/__treen_missing__/.env.local' })).toEqual({
      configured: false,
      redactedKey: null,
    })
  })

  it('reads a shared-layer key and returns it redacted', () => {
    const probe = probeSharedConfig({ env: { DEEPSEEK_KEY: SAMPLE_KEY } })
    expect(probe.configured).toBe(true)
    expect(probe.redactedKey).toBe('sk-4fa…0e52')
    expect(probe.redactedKey).not.toContain('4fa26a19a6684c6bb5cdc30800ac0e52')
  })
})
