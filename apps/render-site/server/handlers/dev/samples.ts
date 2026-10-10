import { devGateNotFound } from '../../utils/dev-gate'
import { listSamples } from '../../utils/dev-samples'
import { runDevRoute } from '../../utils/dev-gate'

/**
 * `GET /api/dev/samples`：列出 zRefs 下可作为回归样本的图。
 *
 * 目录缺失与空目录都走 200 空列表：zRefs 在仓外，缺属常态，页面下拉据此显示空态。
 * 主体在 `utils/dev-samples`，这里只做 Nitro 的进出适配。
 */
export default defineEventHandler(async (event) => {
  const outcome = await runDevRoute(async () => listSamples())
  if (outcome.gated) {
    throw createError(devGateNotFound(event.path))
  }
  setResponseStatus(event, outcome.statusCode)
  return outcome.body
})
