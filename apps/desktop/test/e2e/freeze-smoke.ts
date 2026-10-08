import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { BrowserWindow, app, globalShortcut, nativeImage, screen } from 'electron'
import { ShortcutManager } from '../../src/freeze/shortcuts'
import { DEFAULT_FREEZE_ACCELERATOR, freezeWindowOptions } from '../../src/freeze/window-options'
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
 * - 边缘检测全链路：真 PNG 解码 → 通道序搬运 → detectBorders 检出预期矩形
 *
 * 刻意不覆盖：
 * - 真实截屏（desktopCapturer）：macOS 需屏幕录制授权，自动化会话下会弹系统授权框落到用户桌面；
 *   该路径由注入式单测覆盖，其真机像素验收顺延人工。边缘检测以自造 PNG 走 nativeImage 同一条解码路径。
 * - 覆盖窗的显示：本脚本全程 show:false，不在用户桌面上弹出全屏置顶层。
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

// 打包产物落在 <desktop>/out/ 下，故 overlay.html 在其上一级；可用 env 覆盖。
const overlayPath = process.env.TREEN_OVERLAY_PATH ?? resolve(__dirname, '..', 'overlay.html')

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

/** 把 RGBA 原始行（含每行行首过滤器字节）编码成 PNG data URL。 */function encodePng(width: number, height: number, rawRows: Buffer): string {
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

app.whenReady().then(async () => {
  try {
    await verifyShortcuts()
    const window = await verifyOverlayWindow()
    await verifyCandidateHighlight(window)
    await verifySelectionLock(window)
    await verifyEdgeDetection()
    await verifySystemWindows()
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
