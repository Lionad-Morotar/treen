import { IPC_CHANNELS } from '@treen/ipc'
import type { TreenSettings } from '@treen/shared'
import type { SettingsStore } from './store'

/**
 * 设置通道的主进程侧处理器。
 *
 * 设置页是普通渲染层（contextIsolation + sandbox，无 Node），只能经 preload 暴露的桥回主进程，
 * 故这里注册两个 handle：读当前设置、以补丁写回。
 *
 * `ipcMain` 经注入而非直接 import electron：本模块因此可在纯 Node 下被单测覆盖，
 * 真实 `ipcMain` 在 main 装配时给出。
 */

/** ipcMain.handle 用到的最小面。 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface SettingsIpcLogger {
  warn(message: string): void
}

export interface SettingsIpcOptions {
  ipc: IpcMainLike
  store: SettingsStore
  /**
   * 让新设置生效的钩子，在落盘之后、回执之前调用。热键要即时重注册，而「保存」这件事
   * 只有这里知道，故不在 store 里做副作用，改由装配层经此钩子接管。
   *
   * 抛错即视为本次保存失败：刚写下的值会被回滚，错误继续抛给渲染层提示。
   * 不给回滚的话，「磁盘记着新键、系统里还是旧键」这个中间态会一直留着，
   * 下次启动看起来又对了，用户根本无从判断哪一次生效了。
   */
  apply?(settings: TreenSettings): void
  logger?: SettingsIpcLogger
}

export function registerSettingsIpc(options: SettingsIpcOptions): void {
  options.ipc.handle(IPC_CHANNELS.settingsGet, () => options.store.read())
  options.ipc.handle(IPC_CHANNELS.settingsSet, (_event, patch: unknown) => {
    const previous = options.store.read()
    const saved = options.store.save(patch)
    if (options.apply === undefined) {
      return saved
    }
    try {
      options.apply(saved)
      return saved
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      options.logger?.warn(`设置未能生效，已回滚到上一份配置：${reason}`)
      options.store.save(previous)
      throw error
    }
  })
}
