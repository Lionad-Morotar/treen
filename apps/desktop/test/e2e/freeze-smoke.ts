import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { BrowserWindow, app, globalShortcut, screen } from 'electron'
import { ShortcutManager } from '../../src/freeze/shortcuts'
import { DEFAULT_FREEZE_ACCELERATOR, freezeWindowOptions } from '../../src/freeze/window-options'

/**
 * 冻结域真链路冒烟：在真实 Electron 运行时里验证单测覆盖不到的部分。
 *
 * 覆盖：
 * - 真实 globalShortcut 的注册/替换/注销
 * - freezeWindowOptions 产出的选项被真实 BrowserWindow 接受，几何落在显示器上、置顶、初始隐藏
 * - overlay.html 能被 loadFile 加载，且 __treenSetFrame 帧注入原语可用
 *
 * 刻意不覆盖：
 * - 真实截屏（desktopCapturer）：macOS 需屏幕录制授权，自动化会话下会弹系统授权框落到用户桌面；
 *   该路径由注入式单测覆盖，其真机像素验收顺延人工。
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

async function verifyOverlayWindow(): Promise<void> {
  const display = screen.getAllDisplays()[0]
  check('检测到至少一块显示器', display !== undefined)
  if (display === undefined) {
    return
  }

  const window = new BrowserWindow(
    freezeWindowOptions({
      id: display.id,
      scaleFactor: display.scaleFactor,
      bounds: {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      },
    }),
  )
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

  window.destroy()
}

app.whenReady().then(async () => {
  try {
    await verifyShortcuts()
    await verifyOverlayWindow()
  } catch (error) {
    check('冒烟执行未抛异常', false, error instanceof Error ? error.message : String(error))
  }

  const ok = checks.every((entry) => entry.ok)
  process.stdout.write(`\nTREEN_FREEZE_SMOKE ${JSON.stringify({ ok, checks })}\n`)
  app.exit(ok ? 0 : 1)
})
