import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
// ClipboardItem 在主进程不是全局量（那是渲染端的 Web API），必须从 electron 模块取。
import {
  BrowserWindow,
  ClipboardItem,
  app,
  clipboard,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from 'electron'
import { IPC_CHANNELS } from '@treen/ipc'
import { createSettingsStore } from '../../src/settings/store'
import { registerSettingsIpc } from '../../src/settings/ipc'
import { ShortcutManager } from '../../src/freeze/shortcuts'
import { createFreezeController } from '../../src/freeze/controller'
import { DEFAULT_FREEZE_ACCELERATOR, freezeWindowOptions } from '../../src/freeze/window-options'
import { captureRegionPng, readLockedRegion } from '../../src/freeze/electron-adapters'
import { createSelectionCopier, type CopyOutcome } from '../../src/selection/selection'
import { frameCropWriter } from '../../src/selection/electron-clipboard'
import type { SelectionSource } from '../../src/freeze/controller'
import type { DisplayLike } from '../../src/freeze/geometry'
import {
  MAX_DETECT_EXTENT,
  createSystemWindowSource,
  frameBorders,
} from '../../src/highlight/electron-candidates'
import { bgraToRgba } from '../../src/highlight/pixels'
import {
  buildCandidates,
  isSystemUiBundleId,
  windowCandidates,
  type Candidate,
} from '../../src/highlight/candidates'

/**
 * 冻结域真链路冒烟：在真实 Electron 运行时里验证单测覆盖不到的部分。
 *
 * 覆盖：
 * - 真实 globalShortcut 的注册/替换/注销
 * - freezeWindowOptions 产出的选项被真实 BrowserWindow 接受，几何落在显示器上、置顶、初始隐藏
 * - overlay.html 能被 loadFile 加载，__treenSetFrame 帧注入原语可用
 * - 候选区域的悬停高亮：透明边框占位、命中只换色不位移、离开全部候选即无高亮
 * - 点击锁定选区与主进程的拉取面：__treenGetLocked 跨进程读回锁定几何
 * - 边缘检测全链路：真 PNG 解码 → 通道序搬运 → detectBorders 检出预期矩形
 * - 选区拷贝全链路：真 nativeImage 裁剪 → 真剪贴板写入 → 从剪贴板读回像素校验尺度与 alpha
 *
 * 刻意不覆盖：
 * - 真实截屏（desktopCapturer）：macOS 需屏幕录制授权，自动化会话下会弹系统授权框落到用户桌面；
 *   该路径由注入式单测覆盖，其真机像素验收顺延人工。边缘检测与拷贝都以自造 PNG 走 nativeImage 同一条解码路径。
 * - 覆盖窗的显示：本脚本全程 show:false，不在用户桌面上弹出全屏置顶层。
 *
 * 副作用与还原：选区拷贝必须落到真实系统剪贴板（异步剪贴板 API 的形态错误只有这样才暴露），
 * 而本脚本跑在用户的日常会话里。故写入前先读一份现值，验证完原样写回，脚本不留痕迹。
 */

interface CheckResult {
  name: string
  ok: boolean
  detail?: unknown
}

const checks: CheckResult[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ name, ok, detail })
}

/**
 * 轮询到条件成立为止，返回最终是否成立。
 *
 * 剪贴板与跨进程写入都不是同步生效的：`clipboard.read()` 是异步的，且观测到的值与最近一次
 * `clipboard.write` 之间会错开一拍；设置页的写回也要经一个 IPC 往返才落盘。断言前直接读一次
 * 会与这些异步过程赛跑，故统一走轮询。
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return predicate()
}

/**
 * 把剪贴板内容投影成「每个条目的用户内容类型」。
 *
 * Electron 的 clipboard.read() 会把系统粘贴板条目一并读出来，冠以 `electron application/` 前缀
 * （查找粘贴板，以及同一份内容在原生粘贴板上的别名格式）。它们不是用户内容：macOS 上只带这类类型的
 * 写是空操作，还原时既写不回去，也不该拿它们当作「用户的剪贴板」参与比对。
 *
 * 投影保留条目边界（一项一项比对，而非拍平成一个列表）：条目被合并或拆分同样属于还原劣化，
 * 拍平后长度对得上就会漏判。
 */
function userContentTypes(items: readonly Electron.ClipboardItem[]): string[] {
  return items
    .map((item) =>
      item.types
        .filter((type) => !type.startsWith('electron application/'))
        .join('+'),
    )
    .filter((entry) => entry !== '')
}

// 打包产物落在 <desktop>/out/ 下，故 overlay.html 在其上一级；可用 env 覆盖。
const overlayPath = process.env.TREEN_OVERLAY_PATH ?? resolve(__dirname, '..', 'overlay.html')

// 设置页与其 preload 同处包根，随 overlay.html 一条规则。
const settingsPath = resolve(__dirname, '..', 'settings.html')
const settingsPreloadPath = resolve(__dirname, '..', 'settings-preload.cjs')

const PROBE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

app.disableHardwareAcceleration()

async function verifyShortcuts(): Promise<void> {
  const manager = new ShortcutManager({
    register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
    isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
  })

  check('注册触发热键', manager.register(DEFAULT_FREEZE_ACCELERATOR, () => {}))
  check('Electron 侧确认热键已注册', globalShortcut.isRegistered(DEFAULT_FREEZE_ACCELERATOR))

  manager.register(DEFAULT_FREEZE_ACCELERATOR, () => {})
  check('重复注册后仍只持有一份', manager.registeredAccelerators().length === 1)

  manager.unregister(DEFAULT_FREEZE_ACCELERATOR)
  check('注销后 Electron 侧已释放', !globalShortcut.isRegistered(DEFAULT_FREEZE_ACCELERATOR))
}

/**
 * 改冻结热键的真链路：控制器在真实 globalShortcut 上换键。
 *
 * 单测的注册表是替身，证明不了「系统热键表真的跟着换」；这里要验的是旧键从系统侧消失、
 * 新键真的被系统收下，以及新键被占用时旧键还在（改失败不该把用户原来的热键弄丢）。
 */
async function verifyHotkeyReassignment(): Promise<void> {
  const manager = new ShortcutManager({
    register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
    isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
  })
  const controller = createFreezeController({
    // 本函数只碰热键，冻结链路一律给空实现：真跑一遍截屏会落到用户的桌面上。
    listDisplays: () => [],
    captureFrames: async () => [],
    windows: {
      create: () => {
        throw new Error('换键不该建覆盖窗')
      },
    },
    shortcuts: manager,
    triggerAccelerator: DEFAULT_FREEZE_ACCELERATOR,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })

  // 刻意挑一个系统与常见应用都不占用的四键组合，免得验收跑在别人的热键冲突上。
  const next = 'CommandOrControl+Alt+Shift+J'
  try {
    check('换键前旧键在系统侧已注册', controller.start() && globalShortcut.isRegistered(DEFAULT_FREEZE_ACCELERATOR))

    check('控制器接受新键', controller.applyTriggerAccelerator(next))
    check('新键在系统侧真注册上', globalShortcut.isRegistered(next))
    check('旧键已从系统侧释放', !globalShortcut.isRegistered(DEFAULT_FREEZE_ACCELERATOR))
  } finally {
    controller.dispose()
  }
  check('注销后新旧键都已释放', !globalShortcut.isRegistered(next) && !globalShortcut.isRegistered(DEFAULT_FREEZE_ACCELERATOR))
}

function displayLikeOf(display: Electron.Display) {
  return {
    id: display.id,
    scaleFactor: display.scaleFactor,
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
  }
}

async function verifyOverlayWindow(): Promise<BrowserWindow | null> {
  const display = screen.getAllDisplays()[0]
  check('检测到至少一块显示器', display !== undefined)
  if (display === undefined) {
    return null
  }

  const window = new BrowserWindow(freezeWindowOptions(displayLikeOf(display)))
  window.setAlwaysOnTop(true, 'screen-saver')

  check('窗口置顶', window.isAlwaysOnTop())
  check('窗口初始隐藏', !window.isVisible())

  const bounds = window.getBounds()
  // macOS 会对贴近系统栏位的窗口位置做系统级平移，故尺寸严格比对、位置给 2px 容差。
  check(
    '窗口尺寸等于显示器尺寸',
    bounds.width === display.bounds.width && bounds.height === display.bounds.height,
    { bounds, expected: display.bounds },
  )
  check(
    '窗口位置落在显示器原点附近',
    Math.abs(bounds.x - display.bounds.x) <= 2 && Math.abs(bounds.y - display.bounds.y) <= 2,
    { bounds, expected: display.bounds },
  )

  check('overlay.html 存在', existsSync(overlayPath), overlayPath)
  await window.loadFile(overlayPath)

  const setterType = await window.webContents.executeJavaScript('typeof window.__treenSetFrame')
  check('渲染层暴露 __treenSetFrame', setterType === 'function', setterType)

  await window.webContents.executeJavaScript(`window.__treenSetFrame(${JSON.stringify(PROBE_PNG)})`)
  const applied = await window.webContents.executeJavaScript(
    'document.getElementById("treen-freeze-frame").getAttribute("src")',
  )
  check(
    '帧数据 URL 已写入 img.src',
    typeof applied === 'string' && applied.startsWith('data:image/png'),
    applied,
  )

  return window
}

/** 渲染层探针：读回候选条的几何、命中/锁定标记与边框色，供 Node 侧断言。 */
const RENDERER_PROBE = `(() => {
  const nodes = [...document.querySelectorAll('[data-testid="freeze-candidate"]')]
  const info = (el) => {
    const rect = el.getBoundingClientRect()
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      hit: el.hasAttribute('data-hit'),
      locked: el.hasAttribute('data-locked'),
      source: el.getAttribute('data-source'),
      zIndex: getComputedStyle(el).zIndex,
      borderColor: getComputedStyle(el).borderTopColor,
      backgroundColor: getComputedStyle(el).backgroundColor,
    }
  }
  return {
    count: nodes.length,
    items: nodes.map(info),
    setterType: typeof window.__treenSetCandidates,
    readerType: typeof window.__treenGetLocked,
    lockedRegion: typeof window.__treenGetLocked === 'function' ? window.__treenGetLocked() : 'missing',
  }
})()`

function moveTo(x: number, y: number): string {
  return `document.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true })), true`
}

function clickAt(x: number, y: number): string {
  return `document.dispatchEvent(new MouseEvent('click', { clientX: ${x}, clientY: ${y}, bubbles: true })), true`
}

interface RendererSnapshot {
  count: number
  items: {
    x: number
    y: number
    width: number
    height: number
    hit: boolean
    locked: boolean
    source: string | null
    zIndex: string
    borderColor: string
    backgroundColor: string
  }[]
  setterType: string
  readerType: string
  lockedRegion: { x: number; y: number; width: number; height: number } | null | 'missing'
}

/** 悬停与锁定两轮验证共用同一组候选：外层大、内层小，面积降序与主进程产出次序一致。 */
const PROBE_CANDIDATES: Candidate[] = [
  { x: 0, y: 0, width: 400, height: 300, source: 'window' },
  { x: 50, y: 40, width: 100, height: 80, source: 'edge' },
]
const INNER = { x: 50, y: 40, width: 100, height: 80 }
const OUTER = { x: 0, y: 0, width: 400, height: 300 }

const TRANSPARENT = 'rgba(0, 0, 0, 0)'

/** 轮询等一个条件成立；这里不引测试框架，等的是真机上的异步收敛。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

/**
 * 覆盖层候选渲染与悬停高亮。
 * 用一对外层大、内层小的候选验证两件事：命中取最具体的一条（层叠次序），
 * 以及命中只换颜色不改几何（透明边框占位）。
 */
async function verifyCandidateHighlight(window: BrowserWindow | null): Promise<void> {
  if (window === null || window.isDestroyed()) {
    check('候选高亮冒烟有可用的覆盖窗', false)
    return
  }

  // 面积降序送入，与主进程 orderCandidates 的输出一致：大的在前（z-index 小），小的在后（叠在上面）。
  const candidates = PROBE_CANDIDATES
  const snapshot = async (): Promise<RendererSnapshot> =>
    (await window.webContents.executeJavaScript(RENDERER_PROBE)) as RendererSnapshot

  const setterType = (await snapshot()).setterType
  check('渲染层暴露 __treenSetCandidates', setterType === 'function', setterType)

  await window.webContents.executeJavaScript(
    `window.__treenSetCandidates(${JSON.stringify(candidates)})`,
  )
  const initial = await snapshot()

  check('候选条按注入数量创建', initial.count === 2, initial.count)
  check(
    '候选条几何等于注入的显示器相对 DIP',
    initial.items[0]?.x === 0 &&
      initial.items[0]?.y === 0 &&
      initial.items[0]?.width === 400 &&
      initial.items[0]?.height === 300 &&
      initial.items[1]?.x === 50 &&
      initial.items[1]?.y === 40 &&
      initial.items[1]?.width === 100 &&
      initial.items[1]?.height === 80,
    initial.items,
  )
  check(
    '候选条保留来源标记',
    initial.items[0]?.source === 'window' && initial.items[1]?.source === 'edge',
    initial.items.map((item) => item.source),
  )
  check(
    '小矩形层叠在大矩形之上',
    Number(initial.items[1]?.zIndex) > Number(initial.items[0]?.zIndex),
    initial.items.map((item) => item.zIndex),
  )
  check(
    '默认态全是等宽透明边框且无命中',
    initial.items.every((item) => item.borderColor === TRANSPARENT && !item.hit),
    initial.items,
  )

  // 落在内层小矩形里：命中的应是最具体的一条。
  await window.webContents.executeJavaScript(moveTo(100, 80))
  const inner = await snapshot()
  check(
    '鼠标在内层时只命中内层',
    inner.items[0]?.hit === false && inner.items[1]?.hit === true,
    inner.items.map((item) => item.hit),
  )
  check(
    '命中态边框换成了高亮色',
    inner.items[1] !== undefined && inner.items[1].borderColor !== TRANSPARENT,
    inner.items[1]?.borderColor,
  )
  check(
    '命中前后几何完全不变（无 layout shift）',
    inner.items[1]?.x === initial.items[1]?.x &&
      inner.items[1]?.y === initial.items[1]?.y &&
      inner.items[1]?.width === initial.items[1]?.width &&
      inner.items[1]?.height === initial.items[1]?.height,
    { before: initial.items[1], after: inner.items[1] },
  )

  // 落在外层大矩形里、内层之外：命中者应换成外层。
  await window.webContents.executeJavaScript(moveTo(300, 200))
  const outer = await snapshot()
  check(
    '鼠标移出内层后改命中外层',
    outer.items[0]?.hit === true && outer.items[1]?.hit === false,
    outer.items.map((item) => item.hit),
  )

  // 落在所有候选之外：没有任何高亮。
  await window.webContents.executeJavaScript(moveTo(1200, 900))
  const outside = await snapshot()
  check(
    '鼠标离开所有候选时无高亮',
    outside.items.every((item) => !item.hit && item.borderColor === TRANSPARENT),
    outside.items,
  )
}

function sameRect(
  value: { x: number; y: number; width: number; height: number } | null | 'missing',
  expected: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    value !== null &&
    value !== 'missing' &&
    value.x === expected.x &&
    value.y === expected.y &&
    value.width === expected.width &&
    value.height === expected.height
  )
}

/**
 * 点击锁定选区：点击命中的候选条即把该区域设为选区，主进程经 __treenGetLocked 拉取。
 * 与悬停高亮同一套命中判定（elementFromPoint），故这里只断言锁定态自身的性质：
 * 锁定标记落在被点中的那条、拉取面读出同一几何、锁定不改变几何、后续悬停与改锁仍然可用。
 */
async function verifySelectionLock(window: BrowserWindow | null): Promise<void> {
  if (window === null || window.isDestroyed()) {
    check('选区锁定冒烟有可用的覆盖窗', false)
    return
  }

  const snapshot = async (): Promise<RendererSnapshot> =>
    (await window.webContents.executeJavaScript(RENDERER_PROBE)) as RendererSnapshot

  await window.webContents.executeJavaScript(
    `window.__treenSetCandidates(${JSON.stringify(PROBE_CANDIDATES)})`,
  )

  const readerType = (await snapshot()).readerType
  check('渲染层暴露 __treenGetLocked', readerType === 'function', readerType)

  const initial = await snapshot()
  check('未点击时没有锁定选区', initial.lockedRegion === null, initial.lockedRegion)
  check('未点击时没有任何候选带锁定标记', initial.items.every((item) => !item.locked))

  // 点内层：锁定的应是被点中的那条，几何取自注入的显示器相对 DIP。
  await window.webContents.executeJavaScript(clickAt(100, 80))
  const inner = await snapshot()
  check(
    '页面上任意位置的点击都只锁定被点中的候选条',
    inner.items[0]?.locked === false && inner.items[1]?.locked === true,
    inner.items.map((item) => item.locked),
  )
  check('锁定后读到该选区的几何', sameRect(inner.lockedRegion, INNER), inner.lockedRegion)
  check(
    '锁定态边框换成锁定色且几何不变（透明边框占位）',
    inner.items[1] !== undefined &&
      inner.items[1].borderColor !== TRANSPARENT &&
      inner.items[1].x === initial.items[1]?.x &&
      inner.items[1].y === initial.items[1]?.y &&
      inner.items[1].width === initial.items[1]?.width &&
      inner.items[1].height === initial.items[1]?.height,
    { before: initial.items[1], after: inner.items[1] },
  )

  // 锁定之后悬停仍然工作：移出内层时外层拿到命中标记，而锁定还在内层。
  await window.webContents.executeJavaScript(moveTo(300, 200))
  const hovered = await snapshot()
  check(
    '锁定不妨碍悬停高亮继续工作',
    hovered.items[0]?.hit === true && hovered.items[1]?.locked === true,
    hovered.items,
  )
  check('悬停到别的候选时锁定不变', sameRect(hovered.lockedRegion, INNER), hovered.lockedRegion)

  // 点外层：锁转移，内层失去锁定标记（页面上同时只有一条锁定）。
  await window.webContents.executeJavaScript(clickAt(300, 200))
  const moved = await snapshot()
  check(
    '再次点击把锁定转移到新命中的候选',
    moved.items[0]?.locked === true && moved.items[1]?.locked === false,
    moved.items.map((item) => item.locked),
  )
  check('锁定转移后读到新选区的几何', sameRect(moved.lockedRegion, OUTER), moved.lockedRegion)

  // 点空白处：不改动当前锁定。
  await window.webContents.executeJavaScript(clickAt(1200, 900))
  const empty = await snapshot()
  check('点击空白处不改变锁定', sameRect(empty.lockedRegion, OUTER), empty.lockedRegion)

  // 候选整批换新后旧锁定元素已不在文档里，读取面必须回到「无锁定」而不是指向幽灵元素。
  await window.webContents.executeJavaScript(
    `window.__treenSetCandidates(${JSON.stringify([{ x: 600, y: 500, width: 80, height: 60, source: 'edge' }])})`,
  )
  const reinjected = await snapshot()
  check(
    '候选重新注入后锁定被清空',
    reinjected.lockedRegion === null && reinjected.items.every((item) => !item.locked),
    { region: reinjected.lockedRegion, locks: reinjected.items.map((item) => item.locked) },
  )
}

/**
 * 主进程侧的拉取面：真跑一次 executeJavaScript 跨进程读回渲染层锁定的选区。
 * 单测对这个通道是结构性盲区（替身里没有真的渲染层），它只有真链路能证明。
 */
async function verifyLockedRegionPull(window: BrowserWindow | null): Promise<void> {
  if (window === null || window.isDestroyed()) {
    check('锁定拉取冒烟有可用的覆盖窗', false)
    return
  }

  await window.webContents.executeJavaScript(
    `window.__treenSetCandidates(${JSON.stringify(PROBE_CANDIDATES)})`,
  )
  check('渲染层未锁定时主进程读到 null', (await readLockedRegion(window)) === null)

  await window.webContents.executeJavaScript(clickAt(100, 80))
  const pulled = await readLockedRegion(window)
  check('主进程跨进程读回渲染层锁定的选区', JSON.stringify(pulled) === JSON.stringify(INNER), pulled)

  // 页面里没有该原语时（未来某版 overlay.html 漏了它）读取面返回空而不是抛错，
  // 于是「没有锁定」这条路径不会因为一次注入失配把冻结期拷贝整个打挂。
  const bare = new BrowserWindow({ show: false })
  await bare.loadURL('data:text/html,<h1>no lock here</h1>')
  check('页面没有读取原语时返回 null', (await readLockedRegion(bare)) === null)

  bare.destroy()
  check('窗口已销毁时返回 null', (await readLockedRegion(bare)) === null)
}

/**
 * 冻结期快捷键的生命周期，走真实的 globalShortcut 表。
 *
 * 这条单测覆盖不到：替身注册器里「没释放」只是少了一个 Map 键，真机上却是一个还挂在系统里的
 * 全局快捷键，退出冻结后继续劫持用户的 Cmd+C。用真的 globalShortcut 注册、用真的注册表读状态，
 * 触点则用包在 registrar 外面的记录表模拟按键（Electron 无法程序化触发全局快捷键）。
 */
async function verifyFreezeShortcutLifecycle(): Promise<void> {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) {
    return
  }

  const handlers = new Map<string, () => void>()
  const shortcuts = new ShortcutManager({
    register: (accelerator, handler) => {
      if (!globalShortcut.register(accelerator, handler)) {
        return false
      }
      handlers.set(accelerator, handler)
      return true
    },
    unregister: (accelerator) => {
      globalShortcut.unregister(accelerator)
      handlers.delete(accelerator)
    },
    isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
  })

  let sequence = 0
  const closed: number[] = []
  const controller = createFreezeController({
    listDisplays: () => displays.map(displayLikeOf),
    captureFrames: async () =>
      displays.map((display) => ({
        id: `src-${display.id}`,
        displayId: String(display.id),
        size: { width: 2, height: 2 },
        dataUrl: PROBE_PNG,
      })),
    windows: {
      create: (display) => {
        const id = ++sequence
        return {
          id,
          displayId: display.id,
          focus: () => {},
          close: () => {
            closed.push(id)
          },
          isDestroyed: () => closed.includes(id),
          setCandidates: () => {},
          readSelection: async () => null,
          readLocked: async () => null,
          captureComposite: async () => null,
          setOverlay: () => {},
        }
      },
    },
    shortcuts,
    copyAccelerator: 'CommandOrControl+Shift+C',
    copySelection: { trigger: () => {}, invalidate: () => {} },
  })

  check('触发热键注册进真实快捷键表', controller.start() && globalShortcut.isRegistered(DEFAULT_FREEZE_ACCELERATOR))

  handlers.get(DEFAULT_FREEZE_ACCELERATOR)?.()
  await waitUntil(() => controller.isFrozen())
  check(
    '冻结期退出键与拷贝键都已挂上',
    ['Escape', 'CommandOrControl+Shift+C'].every((accelerator) =>
      globalShortcut.isRegistered(accelerator),
    ),
  )

  // 再按一次触发热键：真机上就是「取消」。
  handlers.get(DEFAULT_FREEZE_ACCELERATOR)?.()
  check('重复触发后不再处于冻结', !controller.isFrozen())
  check('覆盖窗已全部拆掉', closed.length === displays.length, { closed, displays: displays.length })
  check(
    '冻结期的辅助键都已从系统释放',
    !['Escape', 'CommandOrControl+Shift+C'].some((accelerator) =>
      globalShortcut.isRegistered(accelerator),
    ),
  )
  check('触发热键本身留着，供下一次冻结', globalShortcut.isRegistered(DEFAULT_FREEZE_ACCELERATOR))

  controller.dispose()
  check('应用退出后触发热键也释放', !globalShortcut.isRegistered(DEFAULT_FREEZE_ACCELERATOR))
}

/** 四象限加透明块的探针图：颜色分区让裁剪的偏移与尺度错误无从躲藏。 */
function buildCopyProbePng(width: number, height: number): string {
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0 // 过滤器：None
    for (let x = 0; x < width; x += 1) {
      const offset = rowStart + 1 + x * 4
      // R 由左半给出、G 由上半给出：两个轴各有一条颜色分界线，裁错偏移或尺度会立刻显形。
      raw[offset] = x < width / 2 ? 255 : 0
      raw[offset + 1] = y < height / 2 ? 255 : 0
      raw[offset + 2] = 0
      // 左上角一块全透明，用于验证 PNG 链路把 alpha 原样带过剪贴板。
      raw[offset + 3] = x < width / 4 && y < height / 4 ? 0 : 255
    }
  }
  return encodePng(width, height, raw)
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * 选区拷贝全链路：真裁剪 → 真剪贴板 → 读回像素校验。
 *
 * 探针关系刻意设成 2x 屏：显示器 400×300 DIP、帧位图 800×600 像素，于是「按位图像素裁」
 * 与「按 DIP 裁」的结果相差一倍，尺度错误无处可藏。拷贝区域还刻意跨过颜色分界线，
 * 偏移错一个像素就会读到隔壁象限的颜色。
 */
async function verifyClipboardCopy(): Promise<void> {
  const display: DisplayLike = {
    id: 9001,
    scaleFactor: 2,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  }
  const frame = {
    id: 'probe',
    displayId: '9001',
    size: { width: 800, height: 600 },
    dataUrl: buildCopyProbePng(800, 600),
  }
  // 显示器相对 DIP 的选区；帧位图坐标应对应 (100,100) 起、400×300 大。
  const locked = { x: 50, y: 50, width: 200, height: 150 }

  const backup = await clipboard.read()
  const backupTypes = backup.map((item) => item.types.join('+'))
  const backupUserTypes = userContentTypes(backup)
  check(
    '拷贝冒烟开工前能读到剪贴板原状（类型清单见 detail）',
    backup.every((item) => Array.isArray(item.types)),
    backupTypes,
  )

  // 立刻把内容取成内存 Blob，而不是等收尾再取。clipboard.read() 发回的是惰性句柄，取数要回到
  // 粘贴板；本函数中途会往剪贴板写探针图，换过 owner 之后旧内容就可能再也取不回来（实测：
  // 收尾时才重建，文本条目直接取数失败，于是还原成了清空，把用户的剪贴板吃掉）。
  const snapshot = await rebuildClipboardItems(backup)
  const backedUpItems = backup.filter((item) =>
    item.types.some((type) => !type.startsWith('electron application/')),
  ).length
  check(
    '开工前的用户内容已就地取成内存快照（晚取会取不回来）',
    snapshot.length === backedUpItems,
    { snapshot: snapshot.length, expected: backedUpItems },
  )

  try {
    const copier = createSelectionCopier({
      readSources: async (): Promise<readonly SelectionSource[]> => [{ display, frame, locked }],
      writeCrop: frameCropWriter(),
    })

    const outcome = await copier.trigger()
    check(
      '锁定选区按帧位图比例换算成像素矩形',
      JSON.stringify(outcome) ===
        JSON.stringify({ kind: 'copied', displayId: 9001, fromLock: true, pixelRect: { x: 100, y: 100, width: 400, height: 300 } }),
      outcome,
    )

    const cropped = await readClipboardImage()
    check('剪贴板里能按 image/png 读回图像', cropped !== null)
    if (cropped !== null) {
      const { size, pixel } = cropped
      check(
        'HiDPI 屏上拷出的是位图原生像素而不是 DIP 尺寸',
        size.width === 400 && size.height === 300,
        size,
      )
      const transparent = pixel(10, 10)
      check('帧里的透明像素在剪贴板里仍是透明的', transparent.a === 0, transparent)
      const left = pixel(150, 10)
      check('左上象限的黄色原样带过', near(left, { r: 255, g: 255, b: 0 }), left)
      const right = pixel(350, 10)
      check('裁剪的横向偏移正确（越过 x 分界线读到绿色）', near(right, { r: 0, g: 255, b: 0 }), right)
      const bottom = pixel(10, 250)
      check('裁剪的纵向偏移正确（越过 y 分界线读到红色）', near(bottom, { r: 255, g: 0, b: 0 }), bottom)
    }

    const whole = createSelectionCopier({
      readSources: async (): Promise<readonly SelectionSource[]> => [{ display, frame, locked: null }],
      writeCrop: frameCropWriter(),
    })
    const wholeOutcome = (await whole.trigger()) as CopyOutcome
    check(
      '未锁定时拷整幅原始帧',
      wholeOutcome.kind === 'copied' && !wholeOutcome.fromLock,
      wholeOutcome,
    )
    const fullFrame = await readClipboardImage()
    check(
      '整幅拷贝的像素等于帧位图尺寸',
      fullFrame !== null && fullFrame.size.width === 800 && fullFrame.size.height === 600,
      fullFrame?.size,
    )
  } finally {
    // 还原用户现场：无论断言成败都要把开工前的内容写回去，不能让验收动作留在用户的剪贴板里。
    if (snapshot.length > 0) {
      await clipboard.write(snapshot)
    } else {
      clipboard.clear()
    }
  }

  // 只对用户内容负责：读到的值比最近一次写滞后一拍，故等到投影稳定再判定。
  let restoredUserTypes = userContentTypes(await clipboard.read())
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (restoredUserTypes.join('|') === backupUserTypes.join('|')) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    restoredUserTypes = userContentTypes(await clipboard.read())
  }
  check(
    '剪贴板里的用户内容已还原成开工前的样子',
    restoredUserTypes.join('|') === backupUserTypes.join('|'),
    {
      before: backupUserTypes,
      after: restoredUserTypes,
      rawBefore: backupTypes,
      rawAfter: (await clipboard.read()).map((item) => item.types.join('+')),
    },
  )
}

/**
 * 合成拷贝的真链路：真窗口渲染 → 按 DIP 抓一块 → 从 PNG 里读出那一块的颜色。
 *
 * 用自建的隐藏窗口而不是建窗工厂产出的覆盖窗：工厂在帧注入后会 showInactive，
 * 那会在用户桌面上弹出全屏置顶层。这里要验的是 capturePage 的尺度语义与「抓得到渲染内容」，
 * 隐藏窗口同样成立；抓取的实现本身走的是生产同一条 `captureRegionPng`。
 */
async function verifyCompositeCapture(): Promise<void> {
  const display = screen.getAllDisplays()[0]
  check('合成拷贝冒烟需要一块显示器', display !== undefined)
  if (display === undefined) {
    return
  }

  const region = { x: 40, y: 30, width: 200, height: 150 }
  const window = new BrowserWindow(freezeWindowOptions(displayLikeOf(display)))
  try {
    await window.loadFile(overlayPath)
    // 探针盒是渲染层内容：它出现在抓取结果里，就等于证明了合成拷贝抓的是渲染结果而非原始帧。
    // 盒刻意比抓取区域小并落在区域正中，这样同一张图里既有「盒内」也有「盒外」可比。
    await window.webContents.executeJavaScript(
      `(() => {
         const box = document.createElement('div')
         box.setAttribute('data-testid', 'composite-probe')
         box.style.cssText = 'position:fixed;left:100px;top:80px;width:80px;height:60px;background:#ff0000'
         document.body.appendChild(box)
       })()`,
    )

    // 首帧合成之前抓到的会是一张「尺寸对、像素全透明」的空表面，按契约那就是「抓不到像素」。
    // 故轮询到真拿到像素为止，而不是睡一个固定时长赌首绘已经完成。
    let png: Uint8Array | null = null
    for (let attempt = 0; attempt < 120 && png === null; attempt += 1) {
      png = await captureRegionPng(window, region)
      if (png === null) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    check('合成抓取拿到了 PNG 字节', png !== null && png.length > 0, png?.length ?? null)

    if (png !== null) {
      const image = nativeImage.createFromBuffer(Buffer.from(png))
      const size = image.getSize()
      const expected = {
        width: region.width * display.scaleFactor,
        height: region.height * display.scaleFactor,
      }
      check(
        '抓到的是这块区域的物理像素（DIP 乘缩放比），不是整屏也不是 DIP 尺寸',
        Math.abs(size.width - expected.width) <= 2 && Math.abs(size.height - expected.height) <= 2,
        { size, expected, scaleFactor: display.scaleFactor },
      )

      const bitmap = image.toBitmap()
      const at = (x: number, y: number) => {
        const offset = (y * size.width + x) * 4
        return {
          b: bitmap[offset] ?? -1,
          g: bitmap[offset + 1] ?? -1,
          r: bitmap[offset + 2] ?? -1,
          a: bitmap[offset + 3] ?? -1,
        }
      }
      const center = at(Math.floor(size.width / 2), Math.floor(size.height / 2))
      check('抓到的中心像素就是探针盒的红（渲染内容进了抓取结果）', near(center, { r: 255, g: 0, b: 0 }), center)

      const outside = at(2, 2)
      check('盒外像素不是探针红（抓的确实是这一块而不是整屏）', !near(outside, { r: 255, g: 0, b: 0 }), outside)
    }
  } catch (error) {
    check('合成抓取冒烟未抛异常', false, error instanceof Error ? error.message : String(error))
  } finally {
    if (!window.isDestroyed()) {
      window.destroy()
    }
  }
}

/**
 * 把开工前读到的剪贴板内容重建成可写回的条目。
 *
 * clipboard.write 明确拒绝 write 一个来自 clipboard.read 的 ClipboardItem，必须新建；
 * 少数平台类型（文件承诺一类）不给可序列化载荷，只能略过，那一部分格式在还原后会丢，
 * 这是把验收动作压在用户现场上必须认下的代价。
 *
 * 必须在动剪贴板之前调用：它要把每个条目的载荷取进内存，而句柄的取数依赖当时那份粘贴板内容。
 */
async function rebuildClipboardItems(
  items: readonly Electron.ClipboardItem[],
): Promise<Electron.ClipboardItem[]> {
  const rebuilt: Electron.ClipboardItem[] = []
  for (const item of items) {
    const entries: Record<string, Blob | Electron.ClipboardBookmark> = {}
    for (const type of item.types) {
      if (type.startsWith('electron application/')) {
        // 系统粘贴板条目，见 userContentTypes：写不回去，整条只剩这类类型时由上层 clear。
        continue
      }
      try {
        entries[type] = await item.getType(type)
      } catch {
        // 该类型没有可重建的载荷，跳过。
      }
    }
    if (Object.keys(entries).length > 0) {
      rebuilt.push(new ClipboardItem(entries))
    }
  }
  return rebuilt
}

/** 从剪贴板按 image/png 读回图像，并给出按像素取值的小工具。 */
async function readClipboardImage(): Promise<{
  size: { width: number; height: number }
  pixel(x: number, y: number): Rgba
} | null> {
  const items = await clipboard.read()
  const item = items.find((entry) => entry.types.includes('image/png'))
  if (item === undefined) {
    check('剪贴板提供 image/png 表示', false, items.map((entry) => entry.types))
    return null
  }
  const blob = await item.getType('image/png')
  const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()))
  const size = image.getSize()
  const bitmap = image.toBitmap()
  return {
    size,
    // toBitmap 是 BGRA 序（见 verifyEdgeDetection 的同款确认）。
    pixel: (x, y) => {
      const offset = (y * size.width + x) * 4
      return {
        b: bitmap[offset] ?? -1,
        g: bitmap[offset + 1] ?? -1,
        r: bitmap[offset + 2] ?? -1,
        a: bitmap[offset + 3] ?? -1,
      }
    },
  }
}

/**
 * 颜色比对给一点容差：剪贴板在系统侧可能经过一次色彩空间描述往返，纯色不该因此判负，
 * 但容差小到足以识别出「读到了隔壁象限」。
 */
function near(actual: Rgba, expected: { r: number; g: number; b: number }): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) <= 8
  return close(actual.r, expected.r) && close(actual.g, expected.g) && close(actual.b, expected.b) && actual.a === 255
}

/** 把 RGBA 原始行（含每行行首过滤器字节）编码成 PNG data URL。 */
function encodePng(width: number, height: number, rawRows: Buffer): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typeBuffer = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
    return Buffer.concat([length, typeBuffer, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 位深
  header[9] = 6 // 真彩 + Alpha
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rawRows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

function dataUrlBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',')
  return Buffer.from(dataUrl.slice(comma + 1), 'base64')
}

/** 构造一张深底 + 亮矩形的 PNG；自造而非依赖外部样本，冒烟可在任意机器上复现。 */
function buildProbePng(width: number, height: number, rect: [number, number, number, number]): string {
  const raw = Buffer.alloc(height * (1 + width * 4))
  const [rx0, ry0, rx1, ry1] = rect
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4)
    raw[rowStart] = 0 // 过滤器：None
    for (let x = 0; x < width; x += 1) {
      const inside = x >= rx0 && x < rx1 && y >= ry0 && y < ry1
      const value = inside ? 240 : 8
      const offset = rowStart + 1 + x * 4
      raw[offset] = value
      raw[offset + 1] = value
      raw[offset + 2] = value
      raw[offset + 3] = 255
    }
  }
  return encodePng(width, height, raw)
}

/** 左像素纯红、右像素纯蓝的 2×1 图；用颜色对调出通道序。 */
function channelProbePng(): string {
  return encodePng(2, 1, Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255]))
}

let crcTable: number[] | null = null
function crc32(buffer: Buffer): number {
  if (crcTable === null) {
    crcTable = []
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      }
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 边缘检测全链路：自造 PNG 建 nativeImage → 展开位图并搬运通道 → detectBorders 检出矩形。
 * 通道序是实测结论（Electron 给的是 BGRA），这里用真运行时再确认一次，防 Electron 升级后静默改写。
 */
async function verifyEdgeDetection(): Promise<void> {
  const channelImage = nativeImage.createFromBuffer(dataUrlBuffer(channelProbePng()))
  const rgba = [...bgraToRgba(channelImage.toBitmap()).subarray(0, 8)]
  check('nativeImage 位图是 BGRA，搬运后是 RGBA', rgba.join(',') === '255,0,0,255,0,0,255,255', rgba)

  const dataUrl = buildProbePng(400, 300, [40, 30, 360, 270])
  const { frameSize, borders } = frameBorders({
    id: 'probe',
    displayId: '1',
    size: { width: 400, height: 300 },
    dataUrl,
  })

  check(
    '解码出的位图尺寸等于 PNG 尺寸',
    frameSize.width === 400 && frameSize.height === 300,
    frameSize,
  )
  check('边缘检测用默认参数即检出亮矩形', borders.length === 1, borders)
  const detected = borders[0]
  check(
    '检出矩形贴合绘制位置（边缘检测取包围像素）',
    detected !== undefined &&
      Math.abs(detected.x - 39) <= 1 &&
      Math.abs(detected.y - 29) <= 1 &&
      Math.abs(detected.w - 322) <= 1 &&
      Math.abs(detected.h - 242) <= 1,
    detected,
  )

  // 超限帧（本机 Retina 全屏帧是 4112×2658 量级）：长边须压回工作上限内，且坐标仍能换算回原分辨率。
  // 这两件事必须一起成立，压了尺寸却不换算是满屏错位的候选，不压尺寸则是主进程一秒级的停摆。
  const bigWidth = 4100
  const bigHeight = 2650
  const drawn: [number, number, number, number] = [820, 530, 1640, 1060]
  const big = frameBorders({
    id: 'probe',
    displayId: '1',
    size: { width: bigWidth, height: bigHeight },
    dataUrl: buildProbePng(bigWidth, bigHeight, drawn),
  })
  check(
    '超限帧先缩到长边上限再检测',
    Math.max(big.frameSize.width, big.frameSize.height) <= MAX_DETECT_EXTENT &&
      big.frameSize.width < bigWidth,
    { frameSize: big.frameSize, source: { width: bigWidth, height: bigHeight } },
  )
  // 换算回缩图坐标系比对：容器尺寸变了，容差用「缩图像素」表达才是稳定口径。
  const shrink = big.frameSize.width / bigWidth
  const shrinkY = big.frameSize.height / bigHeight
  const match = big.borders.find(
    (border) =>
      Math.abs(border.x - drawn[0] * shrink) <= 3 &&
      Math.abs(border.y - drawn[1] * shrinkY) <= 3 &&
      Math.abs(border.w - (drawn[2] - drawn[0]) * shrink) <= 3,
  )
  check('缩图检出的矩形按位图比例可还原回原分辨率的位置', match !== undefined, {
    borders: big.borders,
    shrink: Math.round(shrink * 1000) / 1000,
  })
}

/**
 * 系统窗口一路的真链路：经真实窗口枚举器拿到窗口列表，并验证双路合成。
 * 枚举依赖外部二进制与屏幕录制权限，本机通常可用；取不到时如实报失败而不是跳过。
 */
async function verifySystemWindows(): Promise<void> {
  const display = screen.getAllDisplays()[0]
  if (display === undefined) {
    return
  }
  const displayLike = displayLikeOf(display)

  let windows: Awaited<ReturnType<ReturnType<typeof createSystemWindowSource>['list']>>
  try {
    windows = await createSystemWindowSource().list()
  } catch (error) {
    check('系统窗口枚举可用', false, error instanceof Error ? error.message : String(error))
    return
  }

  check('系统窗口枚举可用', Array.isArray(windows), `共 ${windows.length} 个窗口`)
  check(
    '窗口条目几何是有限数值',
    windows.every(
      (win) =>
        [win.bounds.x, win.bounds.y, win.bounds.width, win.bounds.height].every(Number.isFinite) &&
        win.bounds.width > 0 &&
        win.bounds.height > 0,
    ),
    windows[0],
  )

  const candidates = windowCandidates(displayLike, windows)
  check(
    '窗口候选都落在本屏范围内',
    candidates.length > 0 &&
      candidates.every(
        (c) =>
          c.x >= 0 &&
          c.y >= 0 &&
          c.x + c.width <= display.bounds.width + 1 &&
          c.y + c.height <= display.bounds.height + 1,
      ),
    candidates.slice(0, 3),
  )
  // 真实枚举确实会带出系统 UI 层窗口（登录窗常以整屏尺寸出现），它们是过滤器的现实作用对象。
  const systemUiCount = windows.filter((win) => isSystemUiBundleId(win.bundleId ?? '')).length
  check('原始窗口列表含系统 UI 层窗口，过滤器有作用对象', systemUiCount > 0, {
    systemUiCount,
    total: windows.length,
  })
  check(
    '窗口候选数不超过原始窗口数（哨兵值、系统层、离屏窗口都已被滤掉）',
    candidates.length <= windows.length,
    { candidates: candidates.length, windows: windows.length },
  )

  // 过滤与剔除的确定性形态用自造列表断言，不依赖本机当时开着哪些窗口。
  const mixed = [
    { bounds: displayLike.bounds, bundleId: 'com.apple.loginwindow' },
    // 同一个系统进程用两种大小写各写一遍：磁盘上的 systemuiserver 是全小写，
    // 文档与直觉常写成驼峰，两种都得被同一条规则挡住。
    { bounds: displayLike.bounds, bundleId: 'com.apple.SystemUIServer' },
    { bounds: displayLike.bounds, bundleId: 'com.apple.systemuiserver' },
    { bounds: displayLike.bounds, bundleId: 'com.apple.Spotlight' },
    {
      bounds: { x: displayLike.bounds.x + 10, y: displayLike.bounds.y + 10, width: 200, height: 150 },
      bundleId: 'com.example.app',
      processId: process.pid,
    },
  ]
  const picked = windowCandidates(displayLike, mixed)
  check(
    '系统 UI 层窗口被剔除、普通窗口保留',
    picked.length === 1 && picked[0]?.width === 200 && picked[0].x === 10,
    picked,
  )
  check(
    '本应用自身的窗口被剔除',
    windowCandidates(displayLike, mixed, { excludeProcessId: process.pid }).length === 0,
  )

  const withoutSelfFilter = windowCandidates(displayLike, windows).length
  const withSelfFilter = windowCandidates(displayLike, windows, { excludeProcessId: process.pid }).length
  check('剔除自身进程不会引入新候选', withSelfFilter <= withoutSelfFilter, {
    withoutSelfFilter,
    withSelfFilter,
  })

  const dataUrl = buildProbePng(400, 300, [40, 30, 360, 270])
  const { frameSize, borders } = frameBorders({
    id: 'probe',
    displayId: '1',
    size: { width: 400, height: 300 },
    dataUrl,
  })
  const merged = buildCandidates({ display: displayLike, frameSize, borders, windows })
  const sources = [...new Set(merged.map((c) => c.source))].sort()
  check('双路合成同时产出边缘与系统窗口候选', sources.join(',') === 'edge,window', sources)
}

/**
 * 设置页的真链路：真 BrowserWindow + 真 preload/contextBridge + 真 ipcMain.handle + 真落盘。
 *
 * 单测对 preload 这一层是结构性盲区——它跨的是进程边界，替身里没有真 ipcRenderer，也验不出
 * preload 是否因 ESM/CJS 形态加载失败。这里用一个临时配置目录，绝不碰用户真实的设置文件。
 */
async function verifySettingsRoundTrip(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'treen-settings-smoke-'))
  const store = createSettingsStore({ userDataDir: dir })
  registerSettingsIpc({ ipc: ipcMain, store })

  let window: BrowserWindow | null = null
  try {
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: settingsPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    await window.loadFile(settingsPath)

    const bridgeType = await window.webContents.executeJavaScript('typeof window.treenSettings')
    check('设置窗 preload 暴露了 treenSettings 桥', bridgeType === 'object', bridgeType)

    const initial = (await window.webContents.executeJavaScript('window.treenSettings.get()')) as
      | { translateText?: unknown; translateCharts?: unknown }
      | null
    check(
      '经真实 IPC 读回默认设置（两开关默认开）',
      initial !== null && initial.translateText === true && initial.translateCharts === true,
      initial,
    )

    const saved = (await window.webContents.executeJavaScript(
      'window.treenSettings.set({ translateCharts: false })',
    )) as { translateText?: unknown; translateCharts?: unknown } | null
    check(
      '经真实 IPC 写回并返回落盘结果',
      saved !== null && saved.translateText === true && saved.translateCharts === false,
      saved,
    )

    const readOnDisk = (): Record<string, unknown> | null =>
      existsSync(join(dir, 'settings.json'))
        ? (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>)
        : null
    check(
      '经桥写回后设置落到配置目录下的 settings.json',
      await waitFor(() => readOnDisk()?.translateCharts === false),
      readOnDisk(),
    )

    // 再走一遍用户真正的路径：勾控件 → change → 页面 save() → 桥 → 落盘 → 回填控件并报已保存。
    // 单测里那个替身桥只证明了 html 脚本自身的逻辑，唯有真 preload 在场才能证明这条链路整条通。
    await window.webContents.executeJavaScript(
      '(() => { const el = document.getElementById("setting-translate-charts"); el.checked = true; el.dispatchEvent(new Event("change")); })()',
    )
    check(
      '界面勾选经真链路写回并落盘',
      await waitFor(() => readOnDisk()?.translateCharts === true),
      readOnDisk(),
    )

    let status = ''
    for (let attempt = 0; attempt < 200; attempt += 1) {
      status = (await window.webContents.executeJavaScript(
        'document.getElementById("settings-status").textContent',
      )) as string
      if (status === '已保存' || status.startsWith('保存失败')) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    check('保存完成后状态行报告已保存', status === '已保存', status)

    const controlChecked = await window.webContents.executeJavaScript(
      'document.getElementById("setting-translate-charts").checked',
    )
    check('保存成功后控件停在勾选态', controlChecked === true, controlChecked)

    // 热键走的是另一条路：keydown → 页面算出 accelerator → 桥 → 落盘。这条链只在真浏览器里成立。
    const hotkeyShown = await window.webContents.executeJavaScript(
      'document.getElementById("setting-freeze-accelerator").value',
    )
    check(
      '设置页把服务端的热键回填进热键框',
      typeof hotkeyShown === 'string' && hotkeyShown !== '',
      hotkeyShown,
    )

    await window.webContents.executeJavaScript(
      'document.getElementById("setting-freeze-accelerator").dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, altKey: true }))',
    )
    check(
      '按下组合键后新热键落到 settings.json',
      await waitFor(() => readOnDisk()?.freezeAccelerator === 'Command+Alt+J'),
      readOnDisk()?.freezeAccelerator,
    )
  } catch (error) {
    check('设置页往返冒烟未抛异常', false, error instanceof Error ? error.message : String(error))
  } finally {
    if (window !== null && !window.isDestroyed()) {
      window.destroy()
    }
    ipcMain.removeHandler(IPC_CHANNELS.settingsGet)
    ipcMain.removeHandler(IPC_CHANNELS.settingsSet)
    rmSync(dir, { recursive: true, force: true })
  }
}

app.whenReady().then(async () => {
  try {
    await verifyShortcuts()
    await verifyHotkeyReassignment()
    const window = await verifyOverlayWindow()
    await verifyCandidateHighlight(window)
    await verifySelectionLock(window)
    await verifyLockedRegionPull(window)
    await verifyEdgeDetection()
    await verifySystemWindows()
    await verifyFreezeShortcutLifecycle()
    await verifyClipboardCopy()
    await verifyCompositeCapture()
    await verifySettingsRoundTrip()
    if (window !== null && !window.isDestroyed()) {
      window.destroy()
    }
  } catch (error) {
    check('冒烟执行未抛异常', false, error instanceof Error ? error.message : String(error))
  }

  const ok = checks.every((entry) => entry.ok)
  process.stdout.write(`\nTREEN_FREEZE_SMOKE ${JSON.stringify({ ok, checks })}\n`)
  app.exit(ok ? 0 : 1)
})
