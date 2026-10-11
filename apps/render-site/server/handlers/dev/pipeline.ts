import { devGateNotFound } from '../../utils/dev-gate'
import { runPipelineRequest } from '../../utils/dev-pipeline'

/**
 * `POST /api/dev/pipeline`：一张图进、整条链路的产物出（OCR → 翻译 → 图表装配）。
 *
 * `timings` 与 `diagnostics` 是这条端点的本体：调试页要能回答「这一步花了多久」以及
 * 「这张图为什么没出来」，二者都只有跑完整条链路才拿得到。
 */
export default defineEventHandler(async (event) => {
  const outcome = await runPipelineRequest(await readBody(event).catch(() => null))
  if (outcome.gated) {
    throw createError(devGateNotFound(event.path))
  }
  setResponseStatus(event, outcome.statusCode)
  return outcome.body
})
