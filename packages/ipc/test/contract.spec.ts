import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, RENDER_SITE_ROUTES, probeSharedConfig } from '../src/index'

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
