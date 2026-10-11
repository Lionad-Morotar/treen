import { RENDER_SITE_DEV_ROUTES, renderSiteDevSamplePath } from '@treen/ipc/routes'
import type { ChartPlacement } from '@treen/shared/overlay'

/**
 * `/dev/pipeline` 调试页对 dev 端点的调用层。
 *
 * 只做两件事：把路径钉在 `@treen/ipc/routes` 的契约常量上（页面里不得出现端点的字面路径），
 * 以及把失败时的**原始响应体**原样带回。后者是这个页面的立身之本——端点返回 400/415/503
 * 时，服务端那条说明了原因的文案是唯一的排障依据，任何「友好提示」都会盖掉它。
 *
 * 路由常量走 `@treen/ipc/routes` 而非包根：根出口带着配置自检，那条链会碰 `node:fs` 与
 * `process`，随客户端包进浏览器会在模块求值期炸掉。
 */

export interface OcrBlockPayload {
  text: string
  confidence: number
  /** 图像像素坐标、左上原点 */
  box: { x: number; y: number; width: number; height: number }
}

export interface OcrResponse {
  blocks: OcrBlockPayload[]
  elapsedMs: number
}

export interface TranslateResponse {
  translations: string[]
  /** `gated[i]` 为真表示第 i 条被「已是目标语言」门控跳过，没真正花调用 */
  gated: boolean[]
}

/** 覆盖计划里的一段译文：坐标已是图像像素，可直接绝对定位。 */
export interface PipelineTextPayload {
  translation: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  lineHeight: number
  /** 已按盒宽折好的行 */
  lines: string[]
  clipped: boolean
}

/**
 * 覆盖计划里的一张图：直接绑定服务端的 `ChartPlacement`，前端不自造形状。
 *
 * 服务端把 `OverlayPlan` 原样序列化，图的固有尺寸因此**不在响应里**——版位已按 contain 算好
 * （width/height 即落点），SVG 自身按 viewBox 缩放。此前这里多写一个 `intrinsic`，真实响应下是
 * undefined，模板读 `intrinsic.width` 直接抛错把整页渲染带崩；而单测的 fixture 是自己塞的
 * intrinsic，形态与真响应不一致，于是把失配盖住了。
 */
export type PipelineChartPayload = ChartPlacement

export interface PipelinePlan {
  fontFamily: string
  lineHeightRatio: number
  texts: PipelineTextPayload[]
  charts: PipelineChartPayload[]
}

export interface PipelineResponse {
  blocks: OcrBlockPayload[]
  translations: string[]
  plan: PipelinePlan
  timings: { ocrMs: number; translateMs: number; chartMs: number }
  /** 链路里的 warn 级日志：图为什么没出来的唯一线索 */
  diagnostics: string[]
}

export interface SamplesResponse {
  /** 样本目录不存在时为 null */
  root: string | null
  samples: Array<{ name: string; size: number }>
}

export interface SampleResponse {
  name: string
  mime: string
  base64: string
}

/** 失败分支：带上服务端吐出的原文，供面板整段呈现。 */
export interface DevFailure {
  ok: false
  status: number
  raw: string
  elapsedMs: number
}

export interface DevSuccess<T> {
  ok: true
  data: T
  elapsedMs: number
}

export type DevCallResult<T> = DevSuccess<T> | DevFailure

export type DevFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface DevCallOptions {
  /** 注入 fetch 以便单测；缺省用全局 fetch */
  fetchImpl?: DevFetch
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

async function requestJson<T>(
  url: string,
  init: RequestInit | undefined,
  fetchImpl: DevFetch,
): Promise<DevCallResult<T>> {
  const started = Date.now()
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch {
    // 连不上（渲染站没起、被拦）不是服务端的错，也没有响应体可摆；status 0 即「没拿到响应」。
    return { ok: false, status: 0, raw: '', elapsedMs: Date.now() - started }
  }

  const raw = await response.text().catch(() => '')
  const elapsedMs = Date.now() - started
  if (!response.ok) {
    return { ok: false, status: response.status, raw, elapsedMs }
  }

  try {
    return { ok: true, data: JSON.parse(raw) as T, elapsedMs }
  } catch {
    // 200 却不是 JSON 同样按失败交出：面板要看到的是响应体本身，而不是一个 undefined。
    return { ok: false, status: response.status, raw, elapsedMs }
  }
}

/**
 * dev 端点被门禁挡成 404 时的中性提示；其余状态码返回 null。
 *
 * 404 在 dev 端点上是预期态：路由表里一直有它们，是 `server/utils/dev-gate.ts` 按环境挡的
 * （条数随调试页扩端点而变，故这里不写死）。说成「服务端异常」或「路由没注册」都会把排障带
 * 偏，故只在这一档补一句说明，其它状态码一律不拿万能文案盖掉 `{ error }` 里的真实原因。
 */
export function devEndpointHint(status: number): string | null {
  if (status !== 404) {
    return null
  }
  return 'dev 端点在路由表上，但当前这个渲染站实例不在 dev 环境，一律 404（生产构建下预期如此）。'
}

export function callOcr(image: string, options: DevCallOptions = {}): Promise<DevCallResult<OcrResponse>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return requestJson<OcrResponse>(
    RENDER_SITE_DEV_ROUTES.ocr,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ image }) },
    fetchImpl,
  )
}

export function callTranslate(
  texts: readonly string[],
  options: DevCallOptions = {},
): Promise<DevCallResult<TranslateResponse>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return requestJson<TranslateResponse>(
    RENDER_SITE_DEV_ROUTES.translate,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ texts: [...texts] }) },
    fetchImpl,
  )
}

/**
 * 跑整条链路：OCR、正文翻译与图表装配一次到位。
 *
 * 与 OCR/翻译两条端点不同，这一条会同时打计费的翻译 API 与本站的渲染端点，故调用方必须
 * 由按钮发起——页面里任何自动触发都会把外部调用的量变成不可控。
 */
export function callPipeline(
  image: string,
  options: DevCallOptions = {},
): Promise<DevCallResult<PipelineResponse>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return requestJson<PipelineResponse>(
    RENDER_SITE_DEV_ROUTES.pipeline,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ image }) },
    fetchImpl,
  )
}

export function callSamples(options: DevCallOptions = {}): Promise<DevCallResult<SamplesResponse>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return requestJson<SamplesResponse>(RENDER_SITE_DEV_ROUTES.samples, { method: 'GET' }, fetchImpl)
}

export function callSample(name: string, options: DevCallOptions = {}): Promise<DevCallResult<SampleResponse>> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return requestJson<SampleResponse>(renderSiteDevSamplePath(name), { method: 'GET' }, fetchImpl)
}

/** 把服务端交回的原文包成可直接塞进 data URL 的形态。 */
export function dataUrlOf(sample: SampleResponse): string {
  return `data:${sample.mime};base64,${sample.base64}`
}
