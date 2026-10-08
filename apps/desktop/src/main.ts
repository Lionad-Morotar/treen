import { join } from 'node:path'
import { BrowserWindow, app, dialog } from 'electron'
import { createLogger, readDeepSeekKey } from '@treen/shared'
import {
  DEFAULT_FREEZE_ACCELERATOR,
  ShortcutManager,
  createFreezeController,
  type FreezeController,
  type SelectionSource,
} from './freeze'
import {
  captureFrames,
  createOverlayWindowFactory,
  electronShortcutRegistrar,
  listDisplays,
  pointOfInterest,
} from './freeze/electron-adapters'
import { createCandidateBuilder } from './highlight/electron-candidates'
import { createSelectionCopier } from './selection'
import { frameCropWriter } from './selection/electron-clipboard'
import {
  createBatchTranslator,
  createDeepSeekCompleter,
  createTranslateSelection,
  macOcrEngine,
} from './translation'
import { describeStartup } from './startup'

const logger = createLogger('desktop')

let freeze: FreezeController | null = null

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({ width: 1024, height: 720, show: false })
  window.once('ready-to-show', () => window.show())
  return window
}

/**
 * 覆盖窗列表由控制器持有，且要到动作真发生的那一刻才是最新的，故按需现取。
 * 拷贝与翻译共用一个读取口，兑现「翻译的目标选区与拷贝同源」。
 */
async function readOverlaySources(): Promise<readonly SelectionSource[]> {
  const handles = freeze?.windows() ?? []
  const sources = await Promise.all(handles.map((handle) => handle.readSelection()))
  return sources.filter((source) => source !== null)
}

/**
 * 装配翻译链路。缺 DeepSeek 密钥时不给翻译动作：冻结与拷贝照常可用，
 * 而不是让一次配置缺失把整个冻结域拆掉。翻译结果先落日志（覆盖渲染是后续切片）。
 */
function createTranslateAction(): (() => Promise<void>) | undefined {
  if (readDeepSeekKey() === undefined) {
    logger.warn('未配置 DEEPSEEK_KEY，翻译键不注册；冻结与拷贝不受影响')
    return undefined
  }
  const translate = createTranslateSelection({
    readSources: readOverlaySources,
    recognize: macOcrEngine(),
    translate: createBatchTranslator({ complete: createDeepSeekCompleter(), logger }),
    pointer: pointOfInterest,
    logger,
  })
  return async () => {
    const outcome = await translate()
    if (outcome.kind === 'translated') {
      const joined = outcome.blocks.map((block) => block.translation).join(' / ')
      logger.info(`翻译：显示器 ${outcome.displayId}，${outcome.blocks.length} 段：${joined}`)
    }
  }
}

/**
 * 装配冻结域：真实 Electron 能力注入给纯逻辑控制器。
 * overlay.html 从 app 根取（`electron .` 下即包目录），不随构建产物走——它不进 main.js 的打包面。
 */
function setupFreeze(): void {
  const copySelection = createSelectionCopier({
    readSources: readOverlaySources,
    writeCrop: frameCropWriter(logger),
    pointer: pointOfInterest,
    logger,
  })

  const controller = createFreezeController({
    listDisplays,
    captureFrames,
    windows: createOverlayWindowFactory(join(app.getAppPath(), 'overlay.html'), logger),
    shortcuts: new ShortcutManager(electronShortcutRegistrar()),
    pointOfInterest,
    buildCandidates: createCandidateBuilder({ logger }),
    copySelection,
    translateSelection: createTranslateAction(),
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
