import { describe, expect, it, vi } from 'vitest'
import { createLogger, redactSecret, redactSecrets } from '../src/index'

const SAMPLE_KEY = 'sk-4fa26a19a6684c6bb5cdc30800ac0e52'

describe('redactSecret', () => {
  it('keeps a readable prefix and suffix while masking the middle', () => {
    expect(redactSecret(SAMPLE_KEY)).toBe('sk-4fa…0e52')
  })

  it('fully masks values too short to redact partially', () => {
    expect(redactSecret('sk-abc')).toBe('***')
  })

  it('trims surrounding whitespace before masking', () => {
    expect(redactSecret(`  ${SAMPLE_KEY}\n`)).toBe('sk-4fa…0e52')
  })
})

describe('redactSecrets', () => {
  it('masks every secret token inside a free-form message', () => {
    const output = redactSecrets(`DEEPSEEK_KEY=${SAMPLE_KEY} (retrying)`)
    expect(output).toBe('DEEPSEEK_KEY=sk-4fa…0e52 (retrying)')
    expect(output).not.toContain('4fa26a19a6684c6bb5cdc30800ac0e52')
  })

  it('leaves text without secrets untouched', () => {
    expect(redactSecrets('nothing to hide here')).toBe('nothing to hide here')
  })
})

describe('createLogger', () => {
  it('prefixes the scope and redacts secrets before they reach the sink', () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const logger = createLogger('desktop', sink)

    logger.info('loaded key', { key: SAMPLE_KEY })

    const call = sink.info.mock.calls.at(0)
    expect(call?.[0]).toBe('[desktop]')
    expect(call?.[1]).toBe('loaded key')
    expect(String(call?.[2])).toBe('{"key":"sk-4fa…0e52"}')
  })

  it('still redacts secrets inside objects with circular references', () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const circular: Record<string, unknown> = { key: SAMPLE_KEY }
    circular.self = circular

    createLogger('desktop', sink).info(circular)

    const payload = String(sink.info.mock.calls.at(0)?.[1])
    expect(payload).not.toContain('4fa26a19a6684c6bb5cdc30800ac0e52')
    expect(payload).toContain('sk-4fa…0e52')
  })

  it('nests child scopes under the parent', () => {
    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    createLogger('desktop', sink).child('ipc').warn('slow')

    expect(sink.warn.mock.calls.at(0)?.[0]).toBe('[desktop:ipc]')
  })
})
