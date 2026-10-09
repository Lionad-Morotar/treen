import { RENDER_SITE_ORIGIN, RENDER_SITE_ROUTES } from '@treen/ipc'
import type { Size } from '../overlay/layout'

/**
 * 常驻渲染站的 HTTP 客户端：mermaid 源码进，SVG 与内容固有尺寸出。
 *
 * 站址与路径都从契约包取（`RENDER_SITE_ORIGIN` / `RENDER_SITE_ROUTES.render`），不在这里另写字符串——
 * 两侧各写一份就会在改端口或路径时静默分叉。渲染站是独立进程，走 HTTP 而非 Electron IPC。
 *
 * 超时用 AbortSignal 兜住悬挂连接：翻译链路里一次卡死会把整条覆盖渲染一起拖住。
 */

/** 渲染成功的结果：SVG 串 + 内容固有像素尺寸（供 contain 适配）。 */
export interface MermaidRenderResult {
  svg: string
  intrinsic: Size
}

export interface RenderSiteClientOptions {
  /** 站址；缺省取契约包的基准 URL（测试可指向替身） */
  origin?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type RenderSiteClient = (source: string) => Promise<MermaidRenderResult>

const DEFAULT_TIMEOUT_MS = 15_000

function errorOf(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    const message = (payload as { error?: unknown }).error
    if (typeof message === 'string') {
      return message.slice(0, 200)
    }
  }
  return ''
}

function isRenderPayload(payload: unknown): payload is { svg: string; width: number; height: number } {
  if (payload === null || typeof payload !== 'object') {
    return false
  }
  const value = payload as { svg?: unknown; width?: unknown; height?: unknown }
  return (
    typeof value.svg === 'string' &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    (value.width as number) > 0 &&
    (value.height as number) > 0
  )
}

/**
 * 生成渲染站客户端。语法非法时渲染站返回非 2xx 与 `{ error }`，这里抛出带原因的错——调用方
 * 据此把「不是一张能渲染的图」与「渲染站不可达」分开处理：前者跳过该候选，后者只记日志。
 */
export function createRenderSiteClient(options: RenderSiteClientOptions = {}): RenderSiteClient {
  const origin = options.origin ?? RENDER_SITE_ORIGIN
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return async (source: string): Promise<MermaidRenderResult> => {
    const response = await fetchImpl(`${origin}${RENDER_SITE_ROUTES.render}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const payload: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(`渲染站请求失败：HTTP ${response.status} ${errorOf(payload)}`)
    }
    if (!isRenderPayload(payload)) {
      throw new Error('渲染站响应不是 { svg, width, height } 形态')
    }
    return { svg: payload.svg, intrinsic: { width: payload.width, height: payload.height } }
  }
}
