import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, probeSharedConfig } from '../src/index'

const SAMPLE_KEY = 'sk-4fa26a19a6684c6bb5cdc30800ac0e52'

describe('ipc contract', () => {
  it('exposes stable channel names', () => {
    expect(Object.values(IPC_CHANNELS)).toEqual([
      'treen:freeze-screen',
      'treen:translate-selection',
      'treen:render-mermaid',
      'treen:capture-composite',
    ])
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
