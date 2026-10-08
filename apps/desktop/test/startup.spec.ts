import { describe, expect, it } from 'vitest'
import { describeStartup } from '../src/startup'

const SAMPLE_KEY = 'sk-4fa26a19a6684c6bb5cdc30800ac0e52'

describe('describeStartup', () => {
  it('flags DeepSeek as configured and never echoes the raw key', () => {
    const descriptor = describeStartup({
      env: { DEEPSEEK_KEY: SAMPLE_KEY },
      envFile: '/__treen_missing__/.env.local',
    })

    expect(descriptor.appName).toBe('Treen')
    expect(descriptor.deepSeekConfigured).toBe(true)
    expect(descriptor.logLine).toContain('sk-4fa…0e52')
    expect(descriptor.logLine).not.toContain('4fa26a19a6684c6bb5cdc30800ac0e52')
  })

  it('flags DeepSeek as unconfigured without any key source', () => {
    const descriptor = describeStartup({ env: {}, envFile: '/__treen_missing__/.env.local' })

    expect(descriptor.deepSeekConfigured).toBe(false)
    expect(descriptor.logLine).toContain('未配置')
    expect(descriptor.logLine).not.toContain(SAMPLE_KEY)
  })
})
