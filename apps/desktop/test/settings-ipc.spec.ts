import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@treen/ipc'
import { registerSettingsIpc, type IpcMainLike } from '../src/settings/ipc'
import { createSettingsStore } from '../src/settings/store'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'treen-ipc-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 假 ipcMain：只收集 handle 注册表，测试直接按通道名调用。 */
function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc: IpcMainLike = {
    handle: (channel, listener) => {
      handlers.set(channel, listener)
    },
  }
  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel)
    if (handler === undefined) {
      throw new Error(`未注册的通道：${channel}`)
    }
    return handler({}, ...args)
  }
  return { ipc, handlers, invoke }
}

describe('registerSettingsIpc', () => {
  it('注册读写两个通道，通道名取自契约常量', () => {
    const { ipc, handlers } = fakeIpc()
    registerSettingsIpc({ ipc, store: createSettingsStore({ userDataDir: tempDir() }) })

    expect([...handlers.keys()].sort()).toEqual(
      [IPC_CHANNELS.settingsGet, IPC_CHANNELS.settingsSet].sort(),
    )
  })

  it('get 返回当前设置，set 以补丁写回并返回落盘结果', async () => {
    const { ipc, invoke } = fakeIpc()
    const store = createSettingsStore({ userDataDir: tempDir() })
    registerSettingsIpc({ ipc, store })

    expect(await invoke(IPC_CHANNELS.settingsGet)).toEqual(
      expect.objectContaining({ translateText: true, translateCharts: true }),
    )
    expect(await invoke(IPC_CHANNELS.settingsSet, { translateCharts: false })).toEqual(
      expect.objectContaining({ translateText: true, translateCharts: false }),
    )
    expect(await invoke(IPC_CHANNELS.settingsGet)).toEqual(
      expect.objectContaining({ translateText: true, translateCharts: false }),
    )
  })

  it('set 的载荷不是对象时按空补丁处理，不炸也不改值', async () => {
    const { ipc, invoke } = fakeIpc()
    registerSettingsIpc({ ipc, store: createSettingsStore({ userDataDir: tempDir() }) })

    expect(await invoke(IPC_CHANNELS.settingsSet, 'garbage')).toEqual(
      expect.objectContaining({ translateText: true, translateCharts: true }),
    )
  })

  it('写回成功后调用 apply，让装配层接即时生效的联动', async () => {
    const { ipc, invoke } = fakeIpc()
    const apply = vi.fn()
    registerSettingsIpc({ ipc, store: createSettingsStore({ userDataDir: tempDir() }), apply })

    await invoke(IPC_CHANNELS.settingsSet, { translateText: false })

    expect(apply).toHaveBeenCalledWith({
      freezeAccelerator: expect.any(String),
      translateText: false,
      translateCharts: true,
    })
  })

  it('apply 抛错即视为保存失败：抛出给渲染层，并把刚写下的值回滚', async () => {
    const { ipc, invoke } = fakeIpc()
    const store = createSettingsStore({ userDataDir: tempDir() })
    store.save({ translateCharts: false })
    const warn = vi.fn()
    registerSettingsIpc({
      ipc,
      store,
      apply: () => {
        throw new Error('热键被占用')
      },
      logger: { warn },
    })

    // handler 同步抛错在真实 Electron 里就是渲染端 invoke 的 rejection，替身里同样以抛错表达。
    expect(() => invoke(IPC_CHANNELS.settingsSet, { translateText: false })).toThrow('热键被占用')
    // 磁盘上不能留下「记着但没生效」的中间态。
    expect(await invoke(IPC_CHANNELS.settingsGet)).toEqual({
      freezeAccelerator: expect.any(String),
      translateText: true,
      translateCharts: false,
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('已回滚'))
  })
})
