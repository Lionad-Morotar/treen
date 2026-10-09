import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TRANSLATE_CHARTS,
  DEFAULT_TRANSLATE_TEXT,
  normalizeSettings,
  readSettings,
  SETTINGS_FILENAME,
  settingsFilePath,
  writeSettings,
  type TreenSettings,
} from '../src/settings'

const DEFAULTS: TreenSettings = { translateText: true, translateCharts: true }
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'treen-settings-'))
  tempDirs.push(dir)
  return dir
}

function writeFixture(content: string): string {
  const dir = tempDir()
  const file = join(dir, SETTINGS_FILENAME)
  writeFileSync(file, content)
  return file
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('默认值与路径', () => {
  it('两个开关默认都是开', () => {
    expect(DEFAULT_TRANSLATE_TEXT).toBe(true)
    expect(DEFAULT_TRANSLATE_CHARTS).toBe(true)
  })

  it('设置文件落在调用方给出的配置目录下，文件名固定', () => {
    expect(settingsFilePath('/tmp/whatever')).toBe(join('/tmp/whatever', SETTINGS_FILENAME))
  })
})

describe('normalizeSettings', () => {
  it('逐字段按类型取值，类型不符的字段回落到该字段默认值', () => {
    expect(
      normalizeSettings({ translateText: false, translateCharts: 'yes' }, DEFAULTS),
    ).toEqual({ translateText: false, translateCharts: true })
  })

  it('丢弃未声明的键', () => {
    expect(normalizeSettings({ translateText: false, evil: 'drop me' }, DEFAULTS)).toEqual({
      translateText: false,
      translateCharts: true,
    })
  })

  it('非对象输入整体回落默认', () => {
    for (const raw of [null, undefined, 42, 'text', []]) {
      expect(normalizeSettings(raw, DEFAULTS)).toEqual(DEFAULTS)
    }
  })
})

describe('readSettings', () => {
  it('文件不存在即全部默认（首次启动的正常态）', () => {
    expect(readSettings({ file: join(tempDir(), 'nope.json'), defaults: DEFAULTS })).toEqual(DEFAULTS)
  })

  it('读回已写入的值', () => {
    const file = writeFixture('{"translateText": false, "translateCharts": true}\n')
    expect(readSettings({ file, defaults: DEFAULTS })).toEqual({
      translateText: false,
      translateCharts: true,
    })
  })

  it('JSON 整体损坏时全部默认并记一条告警', () => {
    const file = writeFixture('{ not json')
    const warn = vi.fn()
    expect(readSettings({ file, defaults: DEFAULTS, logger: { warn } })).toEqual(DEFAULTS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('不是合法 JSON'))
  })

  it('单个字段坏掉不牵连另一个字段', () => {
    const file = writeFixture('{"translateText": false, "translateCharts": 3}')
    expect(readSettings({ file, defaults: DEFAULTS })).toEqual({
      translateText: false,
      translateCharts: true,
    })
  })

  it('文件存在却读不出来时抛带路径上下文的错，不静默按默认处理', () => {
    const dir = tempDir()
    // 让路径指向一个目录：存在（existsSync 为真）但 readFileSync 会 EISDIR。
    const asDirectory = join(dir, SETTINGS_FILENAME)
    mkdirSync(asDirectory)
    expect(() => readSettings({ file: asDirectory, defaults: DEFAULTS })).toThrow(/无法读取设置文件/)
  })
})

describe('writeSettings', () => {
  it('写入前归一：未知键被丢弃、错类型回落默认', () => {
    const file = join(tempDir(), 'nested', SETTINGS_FILENAME)

    const written = writeSettings({
      file,
      values: { translateText: 'nope', translateCharts: false, trojan: true },
      defaults: DEFAULTS,
    })

    expect(written).toEqual({ translateText: true, translateCharts: false })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(written)
  })

  it('父目录不存在时建出来，落盘内容以换行结尾便于手改', () => {
    const file = join(tempDir(), 'a', 'b', SETTINGS_FILENAME)
    writeSettings({ file, values: DEFAULTS, defaults: DEFAULTS })

    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(readSettings({ file, defaults: DEFAULTS })).toEqual(DEFAULTS)
  })

  it('落盘是「临时文件 + rename」，不留 .tmp 残留', () => {
    const dir = tempDir()
    const file = join(dir, SETTINGS_FILENAME)
    writeSettings({ file, values: DEFAULTS, defaults: DEFAULTS })

    expect(() => readFileSync(`${file}.tmp`, 'utf8')).toThrow()
  })
})
