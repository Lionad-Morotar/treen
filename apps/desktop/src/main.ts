import { BrowserWindow, app } from 'electron'
import { createLogger } from '@treen/shared'
import { describeStartup } from './startup'

const logger = createLogger('desktop')

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({ width: 1024, height: 720, show: false })
  window.once('ready-to-show', () => window.show())
  return window
}

app.whenReady().then(() => {
  logger.info(describeStartup().logLine)
  createMainWindow()
})

app.on('window-all-closed', () => {
  // macOS 惯例：关闭全部窗口不退出应用，保留 Dock 入口。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
