import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RENDER_SITE_ROUTES } from '@treen/ipc'
import {
  createFreezeController,
  type FreezeFrame,
  type LockPollTimers,
  type OverlayWindowHandle,
  type SelectionSource,
} from '../../src/freeze/controller'
import { captureFrames, type CaptureScreenSource } from '../../src/freeze/frame-capture'
import { ShortcutManager, type ShortcutRegistrar } from '../../src/freeze/shortcuts'
import type { DisplayLike, Rect, Size } from '../../src/freeze/geometry'
import { createTranslateSelection } from '../../src/translation/link'
import type { OcrEngine, OcrObservation } from '../../src/translation'
import {
  composeOverlayPlan,
  createLatestGate,
  createRegionLockAction,
  type OverlayPlan,
} from '../../src/overlay'
import { createRenderSiteClient } from '../../src/render-site/client'
import { createSelectionCopier } from '../../src/selection/selection'
import { createCompositeCopier } from '../../src/selection/composite'
import { startRenderSite, type RunningRenderSite } from './support/render-site-server'

/**
 * 端到端回放：快捷键 → 冻结 → 选块 → OCR → 翻译/渲染 → 覆盖 → 拷贝，用 zRefs/image.png 作为
 * 唯一的端到端 fixture。无头环境起不了 Electron GUI，故「上屏」这一步以真实渲染层（overlay.html
 * 载进 jsdom）的 DOM 断言接管：覆盖窗要显示的东西，在这条链的末尾就是可读的 DOM 与计划。
 *
 * 真与假的分界是刻意的：
 * - 真：抓屏投影（captureFrames 从 fixture 出帧）、mermaid 渲染（起真 HTTP 渲染站）、覆盖计划装配、
 *   overlay.html 的注入原语、拷贝的像素换算。
 * - 假：OCR 与翻译。OCR 要真跑会拖进 mac-ocr 子进程与屏幕权限，且输出随机器而异；翻译要真跑会
 *   打外网并按次计费。二者是注入点，换成确定性替身不削弱本测试要证明的东西——帧到覆盖的搬运。
 *
 * 覆盖的链不含「shader loading」：它是蓝图中标记为待用户裁决的视觉项（地图 map.md 明确其视觉
 * 语言与实现档位未定），不属可自动推进范围，见本运行的决策台账。
 *
 * 另钉两条跨切片债务：真渲染站的实链进套件（health 探针 + 渲染往返 + 收尾清理），以及 health
 * 契约以消费方形态解析（对齐 packages/ipc 的注释与渲染站实现）。
 */

// 落盘预算：整条链不许写任何文件。「全链路零临时文件」这条验收若只靠跑完 ls tmpdir 对比，
// 会被测试基建自身的噪声稀释；直接在 fs 的写入口打点，任何新引入的落盘都无所遁形。
const fsActivity = vi.hoisted(() => ({ writes: [] as string[] }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const record = (path: unknown): void => {
    if (typeof path === 'string') {
      fsActivity.writes.push(path)
    }
  }
  return {
    ...actual,
    writeFileSync: (path: string, data: unknown, options?: unknown) => {
      record(path)
      return actual.writeFileSync(path, data as never, options as never)
    },
    mkdtempSync: (prefix: string, options?: unknown) => {
      record(prefix)
      return actual.mkdtempSync(prefix, options as never)
    },
  }
})

const FIXTURE = fileURLToPath(new URL('../../../../zRefs/image.png', import.meta.url))
const OVERLAY_HTML = fileURLToPath(new URL('../../overlay.html', import.meta.url))
const DISPLAY_ID = 1

// fixture 是 gitignore 的运行时资产：不进仓，也不随 worktree 带过来。缺它即跳过回放，
// 与同仓 ocr-live.spec 的 fixture 门控同口径——门控锚的是「这条链路此刻跑不跑得了」的真实前置。
const FIXTURE_AVAILABLE = existsSync(FIXTURE)

/** 从 PNG 的 IHDR 块读真实像素尺寸（签名 8 字节 + 长度 4 + 'IHDR' 4 + 宽 4 + 高 4）。 */
function readPngSize(png: Buffer): Size {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** 假 OCR：给定一组 ROI 归一化观察。调用时会记下收到的字节与 ROI，供断言帧真从 fixture 流出。 */
function fakeOcr(observations: readonly OcrObservation[]) {
  const seen: { bytes: Uint8Array; roi: Rect }[] = []
  const engine: OcrEngine = async (bytes, roi) => {
    seen.push({ bytes, roi })
    return { observations: [...observations] }
  }
  return { engine, seen }
}

function fakeShortcuts(): { manager: ShortcutManager; handlers: Map<string, () => void> } {
  const handlers = new Map<string, () => void>()
  const registrar: ShortcutRegistrar = {
    register: (accelerator, handler) => {
      if (handlers.has(accelerator)) {
        return false
      }
      handlers.set(accelerator, handler)
      return true
    },
    unregister: (accelerator) => handlers.delete(accelerator),
    isRegistered: (accelerator) => handlers.has(accelerator),
  }
  return { manager: new ShortcutManager(registrar), handlers }
}

/** 确定性定时器：锁定轮询只在测试显式 tick 时走一轮，不依赖真实时钟。 */
function manualTimers(): { timers: LockPollTimers; tick: () => void } {
  const slots: { active: boolean; handler: () => void }[] = []
  return {
    timers: {
      setInterval: (handler) => {
        slots.push({ active: true, handler })
        return slots.length - 1
      },
      clearInterval: (handle) => {
        const slot = slots[handle as number]
        if (slot !== undefined) {
          slot.active = false
        }
      },
    },
    tick: () => {
      for (const slot of slots) {
        if (slot.active) {
          slot.handler()
        }
      }
    },
  }
}

interface ReplayWindow {
  handle: OverlayWindowHandle
  locked: Rect | null
  plan: OverlayPlan | null
}

function replayWindow(display: DisplayLike, frame: FreezeFrame): ReplayWindow {
  const record: ReplayWindow = { locked: null, plan: null, handle: undefined as unknown as OverlayWindowHandle }
  record.handle = {
    id: 1,
    displayId: display.id,
    focus: () => {},
    close: () => {},
    isDestroyed: () => false,
    setCandidates: () => {},
    readSelection: async (): Promise<SelectionSource> => ({ display, frame, locked: record.locked }),
    readLocked: async () => record.locked,
    setOverlay: (plan) => {
      record.plan = plan
    },
    setLoading: () => {},
    clearLoading: () => {},
    captureComposite: async () => null,
  }
  return record
}

interface OverlayDom {
  texts: { left: string; top: string; text: string }[]
  charts: { left: string; top: string; svg: boolean }[]
}

/**
 * 桌面程序刻意不带 lib.dom（见 src/mermaid/jsdom.d.ts 的理由），故这里用结构化最小接口描述
 * 用到的 DOM 面，不引全局 DOM 类型。
 */
interface ElementLike {
  style: { left: string; top: string }
  textContent: string | null
  querySelector(selector: string): ElementLike | null
  querySelectorAll(selector: string): ElementList
}

interface ElementList {
  readonly length: number
  [index: number]: ElementLike
}

interface OverlayWindowLike {
  __treenSetOverlay(plan: unknown): void
  document: { querySelectorAll(selector: string): ElementList }
}

function toArray(list: ElementList): ElementLike[] {
  return Array.from({ length: list.length }, (_, index) => list[index] as ElementLike)
}

/** 把计划注入真实 overlay.html（jsdom 跑内联脚本）并读回渲染结果。 */
function renderOverlayDom(plan: OverlayPlan): OverlayDom {
  const html = readFileSync(OVERLAY_HTML, 'utf8')
  // 变量中转：本地 jsdom 声明只列了 pretendToBeVisual，这里额外开 runScripts 让内联脚本执行。
  const options = { runScripts: 'dangerously' as const, pretendToBeVisual: true }
  const dom = new JSDOM(html, options)
  const win = dom.window as unknown as OverlayWindowLike
  win.__treenSetOverlay(plan)

  const texts = toArray(win.document.querySelectorAll('[data-testid="freeze-text"]')).map((el) => ({
    left: el.style.left,
    top: el.style.top,
    text: toArray(el.querySelectorAll('[data-testid="freeze-text-line"]'))
      .map((line) => line.textContent ?? '')
      .join(''),
  }))
  const charts = toArray(win.document.querySelectorAll('[data-testid="freeze-chart"]')).map((el) => ({
    left: el.style.left,
    top: el.style.top,
    svg: el.querySelector('svg') !== null,
  }))
  return { texts, charts }
}

let site: RunningRenderSite

// 渲染站是文件级共享资源：只起一次，两个 describe 都消费它。否则各用例各自 startRenderSite
// 会因同一端口互斥而重复起服或抢端口。
beforeAll(async () => {
  site = await startRenderSite()
}, 150_000)

afterAll(async () => {
  await site?.stop()
})

describe.skipIf(!FIXTURE_AVAILABLE)('端到端回放：截图 → OCR → 翻译/渲染 → 覆盖 → 拷贝', () => {
  it('跑通全链路并把覆盖落到真实渲染层 DOM，全程零落盘', async () => {
    // ---- fixture → 帧：抓屏被替换成「读固定 PNG」，但投影逻辑是生产同一份 ----
    const png = readFileSync(FIXTURE)
    const size = readPngSize(png)
    expect(size.width).toBeGreaterThan(0)
    expect(size.height).toBeGreaterThan(0)
    const dataUrl = `data:image/png;base64,${png.toString('base64')}`
    const fixtureSource: CaptureScreenSource = {
      id: 'fixture',
      display_id: String(DISPLAY_ID),
      thumbnail: { getSize: () => size, toDataURL: () => dataUrl },
    }
    const display: DisplayLike = {
      id: DISPLAY_ID,
      scaleFactor: 2,
      // 缩略图与 DIP 同尺度：真实抓屏会按渲染需求缩放，这里让换算比恒为 1，坐标断言更直白。
      bounds: { x: 0, y: 0, width: size.width, height: size.height },
    }

    const frames = await captureFrames({ width: size.width, height: size.height }, async () => [fixtureSource])
    expect(frames).toHaveLength(1)
    expect(frames[0]?.size).toEqual(size)
    expect(frames[0]?.dataUrl).toBe(dataUrl)
    const frame = frames[0]!

    // ---- 选块：fixture 内一块含「mermaid 声明 + 连线行」与一段正文的区域 ----
    const region: Rect = { x: 120, y: 140, width: 640, height: 420 }
    const observations: OcrObservation[] = [
      { text: 'graph LR', confidence: 0.99, boundingBox: { x: 0.05, y: 0.05, width: 0.3, height: 0.12 } },
      { text: 'A[开始] --> B[结束]', confidence: 0.98, boundingBox: { x: 0.05, y: 0.2, width: 0.6, height: 0.12 } },
      { text: '这是一段普通说明文字', confidence: 0.97, boundingBox: { x: 0.05, y: 0.72, width: 0.6, height: 0.12 } },
    ]
    const { engine, seen } = fakeOcr(observations)
    const translateCalls: string[][] = []

    const window = replayWindow(display, frame)
    const { manager, handlers } = fakeShortcuts()
    const clock = manualTimers()
    const readSources = async (): Promise<readonly SelectionSource[]> => [
      { display, frame, locked: window.locked },
    ]

    const translate = createTranslateSelection({
      readSources,
      recognize: engine,
      translate: async (texts) => {
        translateCalls.push([...texts])
        return texts.map((text) => `⟦${text}⟧`)
      },
      pointer: () => ({ x: 10, y: 10 }),
    })

    const render = createRenderSiteClient({ origin: site.origin })
    const regionAction = createRegionLockAction({
      readSettings: () => ({
        freezeAccelerator: 'CommandOrControl+Shift+X',
        translateText: true,
        translateCharts: true,
        translateNodeLabels: true,
      }),
      translate: (displayId, options) => translate(displayId, options),
      compose: (blocks, area, options) =>
        composeOverlayPlan(blocks, area, { render, texts: options.texts }),
      overlays: () => [window.handle],
      gate: createLatestGate(),
    })

    const controller = createFreezeController({
      listDisplays: () => [display],
      // 用的是 frame-capture 的纯投影 + 注入的假抓屏器，即生产路径去掉 desktopCapturer 那一层。
      captureFrames: (thumbnailSize) => captureFrames(thumbnailSize, async () => [fixtureSource]),
      windows: { create: () => window.handle },
      shortcuts: manager,
      triggerAccelerator: 'CommandOrControl+Shift+X',
      pointOfInterest: () => ({ x: 10, y: 10 }),
      onRegionLocked: regionAction,
      timers: clock.timers,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    const tmpBefore = new Set(readdirSync(tmpdir()))

    // ---- 快捷键 → 冻结 ----
    expect(controller.start()).toBe(true)
    handlers.get('CommandOrControl+Shift+X')?.()
    await vi.waitFor(() => expect(controller.isFrozen()).toBe(true))
    expect(handlers.has('Escape')).toBe(true)

    // ---- 选块（渲染层点击锁定）→ 轮询跳变触发翻译 ----
    window.locked = region
    clock.tick()
    await vi.waitFor(() => expect(window.plan).not.toBeNull(), { timeout: 30_000 })
    const plan = window.plan!

    // OCR 吃到的正是 fixture 的字节，ROI 是选区对显示器的归一化。
    expect(seen).toHaveLength(1)
    expect(Buffer.from(seen[0]!.bytes).equals(png)).toBe(true)
    expect(seen[0]!.roi.x).toBeCloseTo(region.x / size.width, 5)
    expect(seen[0]!.roi.y).toBeCloseTo(region.y / size.height, 5)
    expect(seen[0]!.roi.width).toBeCloseTo(region.width / size.width, 5)
    expect(seen[0]!.roi.height).toBeCloseTo(region.height / size.height, 5)
    // 翻译发生在上屏之前，此时还没做 mermaid 检测：识别到的每一段都被送去翻译（含图的源码行）。
    // 「图源码行该不该译」是独立话题（图内文案翻译），不属本切片；这里钉住的是「识别到什么就译什么」。
    expect(translateCalls).toEqual([['graph LR', 'A[开始] --> B[结束]', '这是一段普通说明文字']])

    // ---- 覆盖计划：一张真渲染出的图 + 一段原位的译文 ----
    expect(plan.charts).toHaveLength(1)
    const chart = plan.charts[0]!
    expect(chart.svg).toContain('<svg')
    expect(chart.x).toBeGreaterThanOrEqual(region.x)
    expect(chart.y).toBeGreaterThanOrEqual(region.y)
    expect(chart.x + chart.width).toBeLessThanOrEqual(region.x + region.width + 1e-6)
    expect(chart.y + chart.height).toBeLessThanOrEqual(region.y + region.height + 1e-6)

    expect(plan.texts).toHaveLength(1)
    const text = plan.texts[0]!
    expect(text.lines.join('')).toBe('⟦这是一段普通说明文字⟧')
    // 译文盒落在正文观察的屏幕位置（选区 x + 0.05×宽，y + 0.72×高）。
    expect(text.x).toBeCloseTo(region.x + 0.05 * region.width, 6)
    expect(text.y).toBeCloseTo(region.y + 0.72 * region.height, 6)
    expect(text.width).toBeCloseTo(0.6 * region.width, 6)

    // ---- 上屏：把同一份计划注入真实 overlay.html，断言 DOM ----
    const dom = renderOverlayDom(plan)
    expect(dom.texts).toHaveLength(1)
    expect(dom.texts[0]!.text).toBe('⟦这是一段普通说明文字⟧')
    expect(dom.charts).toHaveLength(1)
    expect(dom.charts[0]!.svg).toBe(true)
    expect(dom.charts[0]!.left).toBe(`${chart.x}px`)

    // ---- 拷贝：原始截图按锁定选区换算帧像素；合成图从渲染结果抓取后写剪贴板 ----
    let croppedRect: Rect | null = null
    const copier = createSelectionCopier({
      readSources,
      writeCrop: async (_frame, rect) => {
        croppedRect = rect
      },
    })
    const copyOutcome = await copier.trigger()
    expect(copyOutcome).toEqual({ kind: 'copied', displayId: DISPLAY_ID, fromLock: true, pixelRect: region })
    expect(croppedRect).toEqual(region)

    const compositePng = new Uint8Array([137, 80, 78, 71])
    let written: Uint8Array | null = null
    const composite = createCompositeCopier({
      readSources,
      capture: async () => compositePng,
      writePng: async (bytes) => {
        written = bytes
      },
    })
    const compositeOutcome = await composite.trigger()
    expect(compositeOutcome).toEqual({ kind: 'copied', displayId: DISPLAY_ID, fromLock: true, region })
    expect(written).toEqual(compositePng)

    // ---- 收尾：退出冻结不留任何残留 ----
    controller.exit()
    expect(handlers.has('Escape')).toBe(false)
    expect(handlers.has('CommandOrControl+Shift+X')).toBe(true)

    // ---- 中间产物：整条链不写任何文件，tmpdir 也不新增 workspace 相关项 ----
    expect(fsActivity.writes).toEqual([])
    const added = readdirSync(tmpdir()).filter((name) => !tmpBefore.has(name))
    expect(added.filter((name) => /treen|frame|ocr|screenshot|selection/i.test(name))).toEqual([])
  }, 120_000)
})

describe('渲染站实链（真 HTTP）', () => {
  it('health 端点以契约形态 { ok, service, version } 应答', async () => {
    const response = await fetch(`${site.origin}${RENDER_SITE_ROUTES.health}`)
    expect(response.ok).toBe(true)
    const payload = (await response.json()) as Record<string, unknown>
    // 壳层按此形态消费健康载荷；注释与实现漂移会让按注释写的消费方解析不到（本切片顺手对齐）。
    expect(payload.ok).toBe(true)
    expect(payload.service).toBe('treen-render-site')
    expect(typeof payload.version).toBe('string')
  })

  it('渲染端点往返：源码进 SVG 出，尺寸为正', async () => {
    const rendered = await createRenderSiteClient({ origin: site.origin })('graph LR\n  A --> B')

    expect(rendered.svg).toContain('<svg')
    expect(rendered.intrinsic.width).toBeGreaterThan(0)
    expect(rendered.intrinsic.height).toBeGreaterThan(0)
  })

  it('非法源码以非 2xx + { error } 形态被拒（契约错误面）', async () => {
    const response = await fetch(`${site.origin}${RENDER_SITE_ROUTES.render}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'graph LR\n A -->' }),
    })
    expect(response.ok).toBe(false)
    const payload = (await response.json()) as { error?: unknown }
    expect(typeof payload.error).toBe('string')
  })
})
