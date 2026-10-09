import { join } from 'node:path'
import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { createLogger, readDeepSeekKey, type TreenSettings } from '@treen/shared'
import {
  ShortcutManager,
  createFreezeController,
  type FreezeController,
  type RegionTranslateAction,
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
import { createCompositeCopier, createSelectionCopier } from './selection'
import { frameCropWriter, pngClipboardWriter } from './selection/electron-clipboard'
import {
  createBatchTranslator,
  createDeepSeekCompleter,
  createTranslateSelection,
  macOcrEngine,
} from './translation'
import { composeOverlayPlan, createLatestGate, createRegionLockAction } from './overlay'
import { createRenderSiteClient } from './render-site'
import { createSettingsStore, registerSettingsIpc, type SettingsStore } from './settings'
import { describeStartup } from './startup'

const logger = createLogger('desktop')

let freeze: FreezeController | null = null

/**
 * 让设置生效的钩子，由冻结域在就绪时装上。
 *
 * 设置通道要在窗口打开前就注册好，冻结域却在之后才建起来，故两者之间需要这么一个接点；
 * 为 null 时（启动的极短窗口内）没有可生效的对象，写入照常落盘。
 */
let applySettings: ((settings: TreenSettings) => void) | null = null

/**
 * 主窗口即设置页：应用启动后常驻的界面只有设置，没有其它内容页。
 *
 * 设置页是普通窗（`electron .` 下文件从 app 根取，与 overlay.html 同处），因此可以用 preload
 * 暴露一个窄桥；这与覆盖窗刻意不带 preload 的取舍不同——覆盖窗只需要主进程单向下发，
 * 而设置页要主动读、主动写，桥是它的正常形态。
 */
function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1024,
    height: 720,
    show: false,
    webPreferences: {
      // preload 必须是 .cjs：包体是 type:module，而 sandbox 渲染进程的 preload 不支持 ESM。
      preload: join(app.getAppPath(), 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => window.show())
  void window.loadFile(join(app.getAppPath(), 'settings.html'))
  return window
}

/**
 * 装配设置域：把设置文件的落点定在用户配置目录，并注册读写通道。
 *
 * 落点用 `app.getPath('userData')` 而非自拼 home 目录——打包态与多用户机上后者的目录布局不同，
 * 自己拼会把配置写到系统约定之外的地方。
 *
 * 设置读不出来时弹一次提示：坏掉的设置不该让应用拒启（store 会退默认值继续跑），
 * 但也不能静默——否则表现成「设置页改了没反应」，用户无从知道磁盘上那份文件根本没读进来。
 * 读不缓存，回调会被反复触发，故这里只提示首次。
 */
function setupSettings(): SettingsStore {
  let reported = false
  const store = createSettingsStore({
    userDataDir: app.getPath('userData'),
    logger,
    onReadFailure: (error) => {
      if (reported) {
        return
      }
      reported = true
      void dialog.showMessageBox({
        type: 'warning',
        message: 'Treen 读不到设置文件，本次按默认设置运行',
        detail: `${error.message}\n\n修复或删除该文件后重启即可恢复自定义设置。`,
      })
    },
  })
  registerSettingsIpc({
    ipc: ipcMain,
    store,
    logger,
    apply: (next) => applySettings?.(next),
  })
  const current = store.read()
  logger.info(
    `设置已就绪：热键 ${current.freezeAccelerator}、翻译文本${current.translateText ? '开' : '关'}、翻译图表${current.translateCharts ? '开' : '关'}、图内文案${current.translateNodeLabels ? '开' : '关'}`,
  )
  return store
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
 * 链路与门控都在 `overlay/region-action`（纯逻辑、可单测）里；这里只做依赖装配：
 * 真实 OCR、翻译、渲染站客户端，以及「从设置读开关」与「覆盖窗列表按需现取」两处读取口。
 * mermaid 的校验即渲染：候选是否真是一张图由渲染站裁决，故主进程不必再背一份 mermaid + jsdom。
 */
function buildRegionLockAction(
  settings: SettingsStore,
): RegionTranslateAction | undefined {
  if (readDeepSeekKey() === undefined) {
    logger.warn('未配置 DEEPSEEK_KEY，点击翻译不启用；冻结与拷贝不受影响')
    return undefined
  }
  const translate = createBatchTranslator({ complete: createDeepSeekCompleter(), logger })
  const render = createRenderSiteClient()

  return createRegionLockAction({
    readSettings: () => settings.read(),
    translate: createTranslateSelection({
      readSources: readOverlaySources,
      recognize: macOcrEngine(),
      translate,
      pointer: pointOfInterest,
      logger,
    }),
    compose: (blocks, region, options) =>
      composeOverlayPlan(blocks, region, {
        // 图表开关关闭时不注入渲染方：整段 mermaid 检测与渲染都不发生，而不是渲染完再丢弃。
        render: options.charts ? render : undefined,
        // 节点文案是图表的子开关：图不渲染时翻译没有落点，一并豁免那次外部调用。
        translateLabels: options.charts && options.nodeLabels ? translate : undefined,
        texts: options.texts,
        logger,
      }),
    overlays: () => freeze?.windows() ?? [],
    gate: createLatestGate(),
    logger,
  })
}

/**
 * 装配冻结域：真实 Electron 能力注入给纯逻辑控制器。
 * overlay.html 从 app 根取（`electron .` 下即包目录），不随构建产物走——它不进 main.js 的打包面。
 */
function setupFreeze(settings: SettingsStore): void {
  const copySelection = createSelectionCopier({
    readSources: readOverlaySources,
    writeCrop: frameCropWriter(logger),
    pointer: pointOfInterest,
    logger,
  })

  // 合成拷贝的取数源是覆盖窗渲染结果而不是截屏帧：译文与图只存在于渲染层。
  // 各屏的窗口列表按需现取，与读选区同源，保证「拷的就是屏幕上正显示的那一屏」。
  const copyComposite = createCompositeCopier({
    readSources: readOverlaySources,
    capture: async (source, region) => {
      const handle = freeze
        ?.windows()
        .find((candidate) => candidate.displayId === source.display.id)
      return handle === undefined ? null : handle.captureComposite(region)
    },
    writePng: pngClipboardWriter(),
    pointer: pointOfInterest,
    logger,
  })

  const triggerAccelerator = settings.read().freezeAccelerator
  const controller = createFreezeController({
    listDisplays,
    captureFrames,
    windows: createOverlayWindowFactory(join(app.getAppPath(), 'overlay.html'), logger),
    shortcuts: new ShortcutManager(electronShortcutRegistrar()),
    pointOfInterest,
    buildCandidates: createCandidateBuilder({ logger }),
    copySelection,
    copyComposite,
    triggerAccelerator,
    onRegionLocked: buildRegionLockAction(settings),
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
    logger.info(`冻结热键就绪：${triggerAccelerator}`)
  } else {
    // 键位被别的应用占着是常态，不是致命错误：应用照常起来，用户去设置页换个键即可。
    logger.warn(`冻结热键 ${triggerAccelerator} 注册失败（可能已被其它应用占用），可在设置页换一个组合键`)
  }
  freeze = controller
  // 设置里改了键位要当场生效：改完再按新键就该冻结。注册失败时抛出，由 IPC 层回滚配置并回报失败。
  applySettings = (next) => {
    if (controller.applyTriggerAccelerator(next.freezeAccelerator)) {
      logger.info(`冻结热键已改为：${next.freezeAccelerator}`)
      return
    }
    throw new Error(`热键 ${next.freezeAccelerator} 注册失败，可能已被其它应用占用`)
  }
}

app.whenReady().then(() => {
  logger.info(describeStartup().logLine)
  // 设置先于窗口与冻结就绪：设置页一打开就要经 IPC 读到它，冻结域也要从它取热键与开关。
  const settings = setupSettings()
  createMainWindow()
  setupFreeze(settings)
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
