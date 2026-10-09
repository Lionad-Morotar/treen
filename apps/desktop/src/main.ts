import { join } from 'node:path'
import { BrowserWindow, app, dialog } from 'electron'
import { createLogger, readDeepSeekKey } from '@treen/shared'
import {
  DEFAULT_FREEZE_ACCELERATOR,
  ShortcutManager,
  createFreezeController,
  type FreezeController,
  type RegionLockTarget,
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
import { composeOverlayPlan, createLatestGate } from './overlay'
import { createRenderSiteClient } from './render-site'
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
 * 装配「点击一块区域就翻译并覆盖回屏幕」的动作。缺 DeepSeek 密钥时不给该动作：
 * 冻结与拷贝照常可用，而不是让一次配置缺失把整个冻结域拆掉。
 *
 * 链路：锁定触发 → OCR + 翻译 → 覆盖计划（译文版位 + mermaid 图版位）→ 注入该屏覆盖窗。
 * mermaid 的校验即渲染：候选是否真是一张图由渲染站裁决，故主进程不必再背一份 mermaid + jsdom。
 * 渲染站不可达时图跳过、译文照出——一块图消失不该让整片译文一起失败。
 */
function createRegionLockAction(): ((target: RegionLockTarget) => void) | undefined {
  if (readDeepSeekKey() === undefined) {
    logger.warn('未配置 DEEPSEEK_KEY，点击翻译不启用；冻结与拷贝不受影响')
    return undefined
  }
  const translate = createTranslateSelection({
    readSources: readOverlaySources,
    recognize: macOcrEngine(),
    translate: createBatchTranslator({ complete: createDeepSeekCompleter(), logger }),
    pointer: pointOfInterest,
    logger,
  })
  const render = createRenderSiteClient()
  // 覆盖是整批替换，而这条链路（OCR + 外部翻译 + 渲染站）耗时不短：连着点两块区域会让两条
  // 链路并发，先发起的可能后完成。闸门按发起次序发号，过期结果不落地。
  const gate = createLatestGate()

  async function translateAndOverlay(target: RegionLockTarget, token: number): Promise<void> {
    const outcome = await translate(target.displayId)
    if (!gate.isCurrent(token)) {
      logger.info(`显示器 ${target.displayId} 的翻译已被更晚的一次点击取代，丢弃结果`)
      return
    }
    if (outcome.kind !== 'translated') {
      logger.info(`点击翻译跳过（${outcome.reason}）：显示器 ${target.displayId}`)
      return
    }
    const handle = freeze?.windows().find((candidate) => candidate.displayId === outcome.displayId)
    if (handle === undefined || handle.isDestroyed()) {
      logger.warn(`显示器 ${outcome.displayId} 的覆盖窗已不在，放弃覆盖`)
      return
    }
    const plan = await composeOverlayPlan(outcome.blocks, outcome.region, { render, logger })
    if (!gate.isCurrent(token)) {
      logger.info(`显示器 ${outcome.displayId} 的覆盖计划已过期，不注入`)
      return
    }
    handle.setOverlay(plan)
    logger.info(
      `覆盖已注入：显示器 ${outcome.displayId}，${plan.texts.length} 段译文、${plan.charts.length} 张图`,
    )
  }

  return (target) => {
    const token = gate.begin()
    void translateAndOverlay(target, token).catch((error: unknown) => {
      logger.warn(`覆盖渲染失败：${error instanceof Error ? error.message : String(error)}`)
    })
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
    onRegionLocked: createRegionLockAction(),
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
