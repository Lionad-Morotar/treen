import { MermaidRenderError, renderMermaidSvg } from '../utils/mermaid-render'

/** `POST /api/render` 的请求体；`source` 为待渲染的 mermaid 源码。 */
interface RenderRequestBody {
  source?: unknown
}

/**
 * mermaid 源码进、SVG 出的渲染端点（路径由 nuxt.config 从 RENDER_SITE_ROUTES 派生）。
 *
 * 错误统一以 `{ error }` 形态返回并显式设状态码，不用 createError：Nitro 的错误序列化会在
 * 生产环境抹掉 message、且字段名与 IPC 契约（`{ error }`）不符。客户端只需读 `error` 字段。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<RenderRequestBody>(event).catch(() => null)
  const source = body?.source
  if (typeof source !== 'string' || source.trim() === '') {
    setResponseStatus(event, 400)
    return { error: '请求体需含非空的 source 字段（mermaid 源码）' }
  }

  try {
    return await renderMermaidSvg(source)
  } catch (error) {
    if (error instanceof MermaidRenderError) {
      setResponseStatus(event, error.statusCode)
      return { error: error.message }
    }
    // 非预期错误也要回契约形态，避免壳层拿到 Nitro 默认错误体而无从判别。
    setResponseStatus(event, 500)
    return { error: error instanceof Error ? error.message : String(error) }
  }
})
