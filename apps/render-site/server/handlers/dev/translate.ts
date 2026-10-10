import { devGateNotFound } from '../../utils/dev-gate'
import { runTranslateRequest } from '../../utils/dev-pipeline'

/**
 * `POST /api/dev/translate`：文本数组进、译文与门控标记出。
 *
 * `gated` 供调试页显示哪些条目被「已是目标语言」门控跳过（没真正花调用），
 * 是判断「这次翻译到底花了几次调用」的唯一依据。
 */
export default defineEventHandler(async (event) => {
  const outcome = await runTranslateRequest(await readBody(event).catch(() => null))
  if (outcome.gated) {
    throw createError(devGateNotFound(event.path))
  }
  setResponseStatus(event, outcome.statusCode)
  return outcome.body
})
