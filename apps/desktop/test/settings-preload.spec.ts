import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS } from '@treen/ipc'

/**
 * preload 是静态 CJS，无法 import TS 契约包，通道字符串只能以字面量重复一份。
 * 这条测试就是那份重复的对拍：契约里的设置通道一旦改名，这里立刻红。
 */
const PRELOAD_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'settings-preload.cjs',
)

describe('settings-preload.cjs', () => {
  const source = readFileSync(PRELOAD_PATH, 'utf8')

  it('用 contract 里定义的字面量调用两个设置通道', () => {
    expect(source).toContain(`'${IPC_CHANNELS.settingsGet}'`)
    expect(source).toContain(`'${IPC_CHANNELS.settingsSet}'`)
  })

  it('用 contract 里定义的字面量调用热键 capture 通道', () => {
    expect(source).toContain(`'${IPC_CHANNELS.hotkeyCaptureStatus}'`)
    expect(source).toContain(`'${IPC_CHANNELS.hotkeyCaptureOpenSettings}'`)
  })

  it('只经 contextBridge 暴露窄接口，不把 ipcRenderer 本体交给渲染层', () => {
    expect(source).toContain('contextBridge.exposeInMainWorld')
    // 渲染层拿到 ipcRenderer 就能自造任意通道，绕开主进程的校验面。
    expect(source).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer/)
  })
})
