import { RENDER_SITE_ORIGIN, RENDER_SITE_ROUTES } from '@treen/ipc'
import { readDeepSeekKey } from '@treen/shared'
import type { Rect } from '@treen/shared/geometry'
import type { MermaidRenderResult } from '@treen/shared/render'
import { composeOverlayPlan, type OverlayPlan } from '@treen/shared/overlay'
import {
  createBatchTranslator,
  createOcrReader,
  createDeepSeekCompleter,
  dataUrlToBytes,
  isChineseDominant,
  macOcrEngine,
  type OcrBlock,
  type OcrEngine,
  type TranslateCompleter,
} from '@treen/shared/translation'
import { DevRouteError, runDevRoute, type DevRouteOutcome } from './dev-gate'

/**
 * `/api/dev/*` 三条端点的主体：OCR 取字、批量翻译、以及串起来的整链路装配。
 *
 * 所有能力都从 `@treen/shared` 取真实实现，这里只做三件端点独有的事：把上传的图像归一成
 * 生产 OCR 认得的形态、把图像尺寸换算成坐标语义、把链路里的 warn 级日志收成 diagnostics。
 * 于是不存在「调试页跑的是另一份实现」——调试页观察不到的问题，生产上一定同样存在。
 *
 * OCR 与翻译的真实出口（Apple Vision 二进制、DeepSeek 网络调用）都是运行时才建立的依赖，
 * 故默认实现在模块里就地装配，其余部分保持可注入：单测能替掉出口而不消耗密钥与网络。
 */

export interface ImageSize {
  width: number
  height: number
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * 从图像字节里读出像素尺寸；认不出返回 null。
 *
 * 走手写解析而非引入图像库：这里只需要宽高两个数，而 OCR 的落点坐标是**图像像素**语义
 * （调试页要在原图上叠加定位），拿不到尺寸就无法把归一化包围盒换算成像素。只支持 PNG 与 JPEG
 * ——它们正是这条端点接受的格式，其余格式宁可明确报错也不猜一个尺寸让坐标静默错位。
 */
export function imageSizeOf(bytes: Uint8Array): ImageSize | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return pngSize(bytes)
  }
  if (bytes.length > 1 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpegSize(bytes)
  }
  return null
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

/** IHDR 紧跟 8 字节签名 + 4 字节长度 + 4 字节类型，宽高各 4 字节大端。 */
function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * JPEG 的尺寸在帧头（SOF）里，而 SOF 之前可以有任意多个其它段，故按标记段逐个走过去。
 * 只有 SOFn（0xC0–0xCF）带尺寸；0xC4（DHT）、0xC8（JPG）、0xCC（DAC）不在此列。
 */
function jpegSize(bytes: Uint8Array): ImageSize | null {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === undefined) {
      return null
    }
    // 无长度的独立标记：填充字节、SOI/EOI、RSTn、TEM。
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = (bytes[offset + 2] ?? 0) * 256 + (bytes[offset + 3] ?? 0)
    const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      const height = (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0)
      const width = (bytes[offset + 7] ?? 0) * 256 + (bytes[offset + 8] ?? 0)
      return { width, height }
    }
    if (length < 2) {
      return null
    }
    offset += 2 + length
  }
  return null
}

/**
 * 入参图像归一成 data URL。
 *
 * 调试页从文件选择拿到的是 data URL，手贴进来可能是裸 base64，两者都收。裸 base64 一律按 PNG
 * 兜：OCR 引擎读的是字节流本身，图像头才是格式的真源，这里补的前缀只影响能否走到那一步。
 */
function toDataUrl(image: string): string {
  const value = image.trim()
  if (value === '') {
    throw new DevRouteError('请求体需含非空的 image 字段（PNG/JPEG 的 data URL 或 base64）')
  }
  return value.includes(',') ? value : `data:image/png;base64,${value}`
}

export interface DevOcrDeps {
  /** 识别引擎；缺省绑定 mac-ocr 真链路 */
  recognize?: OcrEngine
}

export interface DevOcrResult {
  blocks: OcrBlock[]
  elapsedMs: number
}

/**
 * 跑一次 OCR，返回图像像素坐标下的文本块。
 *
 * 选区取整幅图、显示器边界与之等大：归一化 ROI 于是恒为全幅，映射回来的落点即像素坐标。
 * 屏幕上那套「显示器相对 DIP」在这里没有意义——调试页要把盒子叠回原图，原图的单位就是像素。
 */
export async function runOcr(image: string, deps: DevOcrDeps = {}): Promise<DevOcrResult> {
  const { blocks, elapsedMs } = await readOcrBlocks(toDataUrl(image), deps)
  return { blocks, elapsedMs }
}

async function readOcrBlocks(
  dataUrl: string,
  deps: DevOcrDeps,
): Promise<{ blocks: OcrBlock[]; size: ImageSize; elapsedMs: number }> {
  const bytes = dataUrlToBytes(dataUrl)
  const size = imageSizeOf(bytes)
  if (size === null) {
    throw new DevRouteError('读不出图像尺寸：目前只支持 PNG 与 JPEG', 415)
  }
  const region: Rect = { x: 0, y: 0, width: size.width, height: size.height }
  const recognize = deps.recognize ?? macOcrEngine()
  const started = Date.now()
  const blocks = await createOcrReader({ recognize })({ dataUrl }, region, { bounds: region })
  return { blocks, size, elapsedMs: Date.now() - started }
}

export interface DevTranslateDeps {
  /** 模型出口；缺省读 DEEPSEEK_KEY 建真实出口 */
  complete?: TranslateCompleter
}

export interface DevTranslateResult {
  translations: string[]
  /** `gated[i]` 为真表示第 i 条被「已是目标语言」门控跳过，原文回填、未进请求 */
  gated: boolean[]
}

/**
 * 批量翻译，并把「哪些条目没真正送译」一并交出来。
 *
 * gated 由本端点自行判定而非从译文反推：返回原文既可能是门控跳过，也可能是模型如实原样返回，
 * 二者对调试页的意义完全不同——后者是花了一次调用买回来的结果，前者一次调用都没花。
 * 判据与批量翻译器内部同源（`isChineseDominant`），不会与之分叉。
 */
export async function runTranslate(
  texts: readonly string[],
  deps: DevTranslateDeps = {},
): Promise<DevTranslateResult> {
  const translate = createBatchTranslator({ complete: deps.complete ?? defaultCompleter() })
  return { translations: await translate(texts), gated: texts.map(isChineseDominant) }
}

/**
 * 真实出口。缺密钥时抛可操作的 503，而不是让 `createDeepSeekCompleter` 在构造期抛一句
 * 与调用点无关的错——端点要能直接告诉使用者「去哪配」，且这次失败早于任何网络调用。
 */
function defaultCompleter(): TranslateCompleter {
  if (readDeepSeekKey() === undefined) {
    throw new DevRouteError('未配置 DEEPSEEK_KEY：请在仓库根 .env.local 写入它，或导出同名环境变量', 503)
  }
  return createDeepSeekCompleter()
}

export type DevChartRenderer = (source: string) => Promise<MermaidRenderResult>

export interface DevChartRendererOptions {
  origin?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const RENDER_TIMEOUT_MS = 15_000

function errorOf(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    const message = (payload as { error?: unknown }).error
    if (typeof message === 'string') {
      return message.slice(0, 200)
    }
  }
  return ''
}

/**
 * 经本站自己的 `/api/render` 渲染 mermaid。
 *
 * 走 HTTP 而非直接调 `renderMermaidSvg`，是为了让调试页看到的就是生产那一条路径：走同一端口、
 * 同一 handler、同一份 jsdom 垫片。直调虽然同进程更省一次往返，但「调试页渲得出、壳层渲不出」
 * 这类差异就观察不到了。渲染站没起来时这里抛错，由装配层降级为一条诊断——图不出现，译文照常。
 */
export function createSiteChartRenderer(options: DevChartRendererOptions = {}): DevChartRenderer {
  const origin = options.origin ?? RENDER_SITE_ORIGIN
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS

  return async (source) => {
    const response = await fetchImpl(`${origin}${RENDER_SITE_ROUTES.render}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`渲染站拒绝渲染：HTTP ${response.status} ${errorOf(payload)}`)
    }
    if (payload === null || typeof payload !== 'object') {
      throw new Error('渲染站响应不是 { svg, width, height } 形态')
    }
    const value = payload as { svg?: unknown; width?: unknown; height?: unknown }
    const { svg, width, height } = value
    if (typeof svg !== 'string' || typeof width !== 'number' || typeof height !== 'number') {
      throw new Error('渲染站响应不是 { svg, width, height } 形态')
    }
    return { svg, intrinsic: { width, height } }
  }
}

export interface DevPipelineRequest {
  image: string
  /** 是否翻译正文；缺省 true */
  translateText?: boolean
  /** 是否检测并渲染图表；缺省 true */
  translateCharts?: boolean
}

export interface DevPipelineDeps extends DevOcrDeps, DevTranslateDeps {
  /** 图表渲染方；缺省经本站 /api/render */
  render?: DevChartRenderer
}

export interface DevPipelineTimings {
  ocrMs: number
  translateMs: number
  chartMs: number
}

export interface DevPipelineResult {
  blocks: OcrBlock[]
  translations: string[]
  plan: OverlayPlan
  timings: DevPipelineTimings
  /** 链路里的 warn 级日志：几何求不到区域、渲染被拒等「为什么这张图没出来」的线索 */
  diagnostics: string[]
}

/**
 * 一次跑完 OCR → 文本翻译 → 图表装配，并把耗时与诊断一并交出。
 *
 * 关掉某个开关时连那次外部调用都省掉（与生产链路一致）：翻译关掉时 translations 以空串占位，
 * 与 blocks 等长以便按索引对齐；图表关掉时干脆不注入渲染方，整段 mermaid 检测都不发生。
 * 图内文案翻译没有独立的开关，随「翻译文本」一起生效——它是图表的子能力，图不译时它没有落点。
 */
export async function runPipeline(
  request: DevPipelineRequest,
  deps: DevPipelineDeps = {},
): Promise<DevPipelineResult> {
  const translateText = request.translateText !== false
  const translateCharts = request.translateCharts !== false

  const { blocks, size, elapsedMs: ocrMs } = await readOcrBlocks(toDataUrl(request.image), deps)
  const texts = blocks.map((block) => block.text)

  const diagnostics: string[] = []
  const logger = {
    warn: (message: string) => {
      diagnostics.push(message)
    },
    info: () => {},
  }

  let translations: string[]
  let translateMs = 0
  if (translateText) {
    const translate = createBatchTranslator({ complete: deps.complete ?? defaultCompleter() })
    const started = Date.now()
    translations = await translate(texts)
    translateMs = Date.now() - started
  } else {
    translations = texts.map(() => '')
  }

  const region: Rect = { x: 0, y: 0, width: size.width, height: size.height }
  const chartStarted = Date.now()
  const plan = await composeOverlayPlan(
    blocks.map((block, index) => ({
      source: block.text,
      translation: translations[index] ?? '',
      box: block.box,
    })),
    region,
    {
      render: translateCharts ? (deps.render ?? createSiteChartRenderer()) : undefined,
      translateLabels: translateCharts && translateText ? labelTranslator(deps) : undefined,
      texts: translateText,
      logger,
    },
  )

  return {
    blocks,
    translations,
    plan,
    timings: { ocrMs, translateMs, chartMs: Date.now() - chartStarted },
    diagnostics,
  }
}

/** 节点文案翻译复用正文的批量翻译器：同一份门控与降级，不另建一条出口。 */
function labelTranslator(deps: DevPipelineDeps): (labels: readonly string[]) => Promise<string[]> {
  return createBatchTranslator({ complete: deps.complete ?? defaultCompleter() })
}

function requireObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object') {
    throw new DevRouteError('请求体需是 JSON 对象')
  }
  return body as Record<string, unknown>
}

function requireString(body: unknown, field: string): string {
  const value = requireObject(body)[field]
  if (typeof value !== 'string') {
    throw new DevRouteError(`请求体需含字符串字段 ${field}`)
  }
  return value
}

function requireTexts(body: unknown): string[] {
  const value = requireObject(body).texts
  const list: unknown[] = Array.isArray(value) ? [...value] : []
  const texts = list.filter((item): item is string => typeof item === 'string')
  if (texts.length !== list.length) {
    throw new DevRouteError('请求体的 texts 需是字符串数组')
  }
  return texts
}

/** `POST /api/dev/ocr` 的请求处理；门禁与错误映射由 runDevRoute 统一收口。 */
export async function runOcrRequest(body: unknown, deps: DevOcrDeps = {}): Promise<DevRouteOutcome> {
  return runDevRoute(() => runOcr(requireString(body, 'image'), deps))
}

/** `POST /api/dev/translate` 的请求处理。 */
export async function runTranslateRequest(
  body: unknown,
  deps: DevTranslateDeps = {},
): Promise<DevRouteOutcome> {
  return runDevRoute(() => runTranslate(requireTexts(body), deps))
}

/** `POST /api/dev/pipeline` 的请求处理。 */
export async function runPipelineRequest(
  body: unknown,
  deps: DevPipelineDeps = {},
): Promise<DevRouteOutcome> {
  return runDevRoute(() => {
    const raw = requireObject(body)
    if (raw.translateText !== undefined && typeof raw.translateText !== 'boolean') {
      throw new DevRouteError('translateText 需是布尔值')
    }
    if (raw.translateCharts !== undefined && typeof raw.translateCharts !== 'boolean') {
      throw new DevRouteError('translateCharts 需是布尔值')
    }
    return runPipeline(
      {
        image: requireString(body, 'image'),
        translateText: raw.translateText,
        translateCharts: raw.translateCharts,
      },
      deps,
    )
  })
}
