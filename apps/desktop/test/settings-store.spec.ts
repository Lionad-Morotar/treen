import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSettingsStore, SETTINGS_DEFAULTS } from '../src/settings/store'
import { DEFAULT_FREEZE_ACCELERATOR } from '../src/freeze/window-options'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'treen-store-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('createSettingsStore', () => {
  it('首次读取返回默认值（目录里还没有设置文件）', () => {
    const store = createSettingsStore({ userDataDir: tempDir() })
    expect(store.read()).toEqual(SETTINGS_DEFAULTS)
  })

  it('保存后立刻能读回，且落在配置目录下的 settings.json', () => {
    const dir = tempDir()
    const store = createSettingsStore({ userDataDir: dir })

    expect(store.save({ translateText: false })).toEqual(
      expect.objectContaining({ translateText: false, translateCharts: true }),
    )
    expect(store.read()).toEqual(
      expect.objectContaining({ translateText: false, translateCharts: true }),
    )
  })

  it('热键默认取热键注册域的常量，改键后能读回', () => {
    const store = createSettingsStore({ userDataDir: tempDir() })

    expect(store.read().freezeAccelerator).toBe(DEFAULT_FREEZE_ACCELERATOR)
    expect(store.save({ freezeAccelerator: 'Alt+T' }).freezeAccelerator).toBe('Alt+T')
    expect(store.read().freezeAccelerator).toBe('Alt+T')
  })

  it('补丁只改指定字段，另一字段沿用磁盘现状而非默认', () => {
    const store = createSettingsStore({ userDataDir: tempDir() })

    store.save({ translateCharts: false })
    // 再改文本开关：图表开关应保持关，而不是被悄悄打回默认。
    const after = store.save({ translateText: false })

    expect(after).toEqual(
      expect.objectContaining({ translateText: false, translateCharts: false }),
    )
  })

  it('写入被归一：未知键与错类型都进不了磁盘', () => {
    const store = createSettingsStore({ userDataDir: tempDir() })

    const saved = store.save({ translateText: 'on', trojan: 1 })

    expect(saved).toEqual(
      expect.objectContaining({ translateText: true, translateCharts: true, translateNodeLabels: true }),
    )
    expect(Object.keys(saved).sort()).toEqual([
      'freezeAccelerator',
      'translateCharts',
      'translateNodeLabels',
      'translateText',
    ])
    expect(store.read()).toEqual(saved)
  })

  it('补丁里的错类型字段回落到磁盘现状而非产品默认', () => {
    const store = createSettingsStore({ userDataDir: tempDir() })
    store.save({ translateCharts: false })

    // 一个发错类型的控件不该把另一个正常字段打回出厂值。
    const after = store.save({ translateText: 'on' })

    expect(after).toEqual(expect.objectContaining({ translateText: true, translateCharts: false }))
    expect(store.read()).toEqual(after)
  })

  it('每次读都落盘：外部直接改文件后 store 立刻看到新值（无缓存失同步）', () => {
    const dir = tempDir()
    const store = createSettingsStore({ userDataDir: dir })
    store.save({ translateText: true })

    // 模拟外部编辑（另一个进程/手改）
    createSettingsStore({ userDataDir: dir }).save({ translateText: false })

    expect(store.read().translateText).toBe(false)
  })

  it('设置文件读不出来时退默认值继续跑，并把失败交出去（不静默）', () => {
    const dir = tempDir()
    // 同名目录顶替文件：existsSync 为真而 readFileSync 必抛，正是「存在但读不出」的形态。
    mkdirSync(join(dir, 'settings.json'))
    const failures: string[] = []
    const store = createSettingsStore({
      userDataDir: dir,
      onReadFailure: (error) => failures.push(error.message),
    })

    expect(store.read()).toEqual(SETTINGS_DEFAULTS)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('settings.json')

    // 读不缓存，失败会反复触发；去重是调用方的事，这里只保证每次都出声。
    store.read()
    expect(failures).toHaveLength(2)
  })
})
