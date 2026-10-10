import { devGateNotFound, runDevRoute } from '../../utils/dev-gate'
import { readSample } from '../../utils/dev-samples'

/**
 * `GET /api/dev/samples/**:name`：交出一张样本图的内容。
 *
 * 名字是 URL 路径里的一段，路由层已完成匹配，但不会替我们解码——`%2F` 之类要在这里还原，
 * 否则带目录的样本名会被当成字面串去开文件。解码失败保持原样下传：交给 `readSample` 判
 * 非法名字，比在这里吞掉更能说明问题。
 */
export default defineEventHandler(async (event) => {
  const raw = getRouterParam(event, 'name') ?? ''
  let name = raw
  try {
    name = decodeURIComponent(raw)
  } catch {
    name = raw
  }

  const outcome = await runDevRoute(async () => readSample(name))
  if (outcome.gated) {
    throw createError(devGateNotFound(event.path))
  }
  setResponseStatus(event, outcome.statusCode)
  return outcome.body
})
