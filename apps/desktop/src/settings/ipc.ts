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
   * 设置写回成功后的回调。热键要在保存那一刻即时重注册，而「保存」这件事只有这里知道，
   * 故不在 store 里做副作用，改由装配层经此钩子接管。
   */
  onSaved?(settings: TreenSettings): void
  logger?: SettingsIpcLogger
}

export function registerSettingsIpc(options: SettingsIpcOptions): void {
  options.ipc.handle(IPC_CHANNELS.settingsGet, () => options.store.read())
  options.ipc.handle(IPC_CHANNELS.settingsSet, (_event, patch: unknown) => {
    const saved = options.store.save(patch)
    // 钩子抛错不能让写入看起来失败：设置已经落盘，重注册失败另有回显路径（仅记日志）。
    try {
      options.onSaved?.(saved)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      options.logger?.warn(`设置已保存，但保存后的联动失败：${reason}`)
    }
    return saved
  })
}
