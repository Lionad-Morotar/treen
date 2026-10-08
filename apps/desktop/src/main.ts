import { join } from 'node:path'
import { BrowserWindow, app, dialog } from 'electron'
import { createLogger } from '@treen/shared'
import {
  DEFAULT_FREEZE_ACCELERATOR,
  ShortcutManager,
  createFreezeController,
  type FreezeController,
} from './freeze'
import {
  captureFrames,
  createOverlayWindowFactory,
  electronShortcutRegistrar,
  listDisplays,
  pointOfInterest,
} from './freeze/electron-adapters'
import { describeStartup } from './startup'

const logger = createLogger('desktop')

let freeze: FreezeController | null = null

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({ width: 1024, height: 720, show: false })
  window.once('ready-to-show', () => window.show())
  return window
}

/**
 * 装配冻结域：真实 Electron 能力注入给纯逻辑控制器。
 * overlay.html 从 app 根取（`electron .` 下即包目录），不随构建产物走——它不进 main.js 的打包面。
 */
function setupFreeze(): void {
  const controller = createFreezeController({
    listDisplays,
    captureFrames,
    windows: createOverlayWindowFactory(join(app.getAppPath(), 'overlay.html'), logger),
    shortcuts: new ShortcutManager(electronShortcutRegistrar()),
    pointOfInterest,
    // 进入冻结失败（最常见的首跑原因是未授予屏幕录制权限）必须让用户看见，否则表现成「按了没反应」。
    reportError: (message) => {
      void dialog.showMessageBox({
        type: 'error',
        message: 'Treen 无法进入冻结态',
        detail: message,
      })
    },
    logger,
  })
  if (controller.start()) {
    logger.info(`冻结热键就绪：${DEFAULT_FREEZE_ACCELERATOR}`)
  } else {
    logger.warn('冻结热键注册失败，可能已被其它应用占用；请改用其它组合键（设置项待后续切片提供）')
  }
  freeze = controller
}

app.whenReady().then(() => {
  logger.info(describeStartup().logLine)
  createMainWindow()
  setupFreeze()
})

app.on('will-quit', () => {
  // 必须显式注销：残留的全局快捷键会一直占用系统组合键，且冻结覆盖层需随应用一起拆掉。
  freeze?.dispose()
})

app.on('window-all-closed', () => {
  // macOS 惯例：关闭全部窗口不退出应用，保留 Dock 入口。
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
