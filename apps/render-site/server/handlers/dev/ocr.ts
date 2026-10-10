import { runOcrRequest } from '../../utils/dev-pipeline'

/**
 * `POST /api/dev/ocr`：图像进、带像素坐标的文本块出。
 *
 * 路由由 nuxt.config 从 `RENDER_SITE_DEV_ROUTES` 派生；主体与门禁都在 `utils/dev-pipeline`，
 * 这里只做 Nitro 的进出适配——主体保持可被单测直接 import，不必为测它起一个 HTTP 服务。
 */
export default defineEventHandler(async (event) => {
  const outcome = await runOcrRequest(await readBody(event).catch(() => null))
  setResponseStatus(event, outcome.statusCode)
  return outcome.body
})
