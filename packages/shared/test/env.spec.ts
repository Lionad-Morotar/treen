import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findLocalEnvFile, readDeepSeekKey, requireDeepSeekKey } from '../src/index'

const SAMPLE_KEY = 'sk-4fa26a19a6684c6bb5cdc30800ac0e52'
const tempDirs: string[] = []

function fixtureEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'treen-shared-'))
  tempDirs.push(dir)
  const file = join(dir, '.env.local')
  writeFileSync(file, content)
  return file
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('readDeepSeekKey', () => {
  it('prefers an injected environment variable over the env file', () => {
    const file = fixtureEnvFile('DEEPSEEK_KEY=sk-fromfile000000\n')
    expect(readDeepSeekKey({ env: { DEEPSEEK_KEY: 'sk-fromenv111111' }, envFile: file })).toBe(
      'sk-fromenv111111',
    )
  })

  it('reads DEEPSEEK_KEY from the given .env.local file', () => {
    const file = fixtureEnvFile(`# comment line\nDEEPSEEK_KEY="${SAMPLE_KEY}"\nOTHER=1\n`)
    expect(readDeepSeekKey({ env: {}, envFile: file })).toBe(SAMPLE_KEY)
  })

  it('returns undefined when neither the env nor the file provides the key', () => {
    expect(readDeepSeekKey({ env: {}, envFile: '/__treen_missing__/.env.local' })).toBeUndefined()
  })

  it('treats an empty value as absent', () => {
    const file = fixtureEnvFile('DEEPSEEK_KEY=\n')
    expect(readDeepSeekKey({ env: {}, envFile: file })).toBeUndefined()
  })

  it('surfaces a contextual error when the env file exists but cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'treen-shared-unreadable-'))
    tempDirs.push(dir)
    const asDirectory = join(dir, '.env.local')
    mkdirSync(asDirectory)

    expect(() => readDeepSeekKey({ env: {}, envFile: asDirectory })).toThrow(/无法读取环境文件/)
  })
})

describe('requireDeepSeekKey', () => {
  it('throws an actionable error naming the variable when the key is absent', () => {
    expect(() => requireDeepSeekKey({ env: {}, envFile: '/__treen_missing__/.env.local' })).toThrow(
      /DEEPSEEK_KEY/,
    )
  })
})

describe('findLocalEnvFile', () => {
  it('finds .env.local by walking up from a nested directory', () => {
    const file = fixtureEnvFile('DEEPSEEK_KEY=sk-x1234567\n')
    expect(findLocalEnvFile(join(dirname(file), 'nested', 'deeper'))).toBe(file)
  })

  it('returns undefined when no ancestor carries .env.local', () => {
    const empty = mkdtempSync(join(tmpdir(), 'treen-shared-empty-'))
    tempDirs.push(empty)
    expect(findLocalEnvFile(empty)).toBeUndefined()
  })

  it('stops at the workspace root instead of reading an unrelated parent .env.local', () => {
    const outer = mkdtempSync(join(tmpdir(), 'treen-shared-outer-'))
    tempDirs.push(outer)
    writeFileSync(join(outer, '.env.local'), 'DEEPSEEK_KEY=sk-unrelated0000\n')
    const project = join(outer, 'project')
    const nested = join(project, 'nested', 'deep')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(project, 'pnpm-workspace.yaml'), 'packages: []\n')

    expect(findLocalEnvFile(nested)).toBeUndefined()
  })
})
