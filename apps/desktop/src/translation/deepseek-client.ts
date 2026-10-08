import { requireDeepSeekKey } from '@treen/shared'
import type { TranslateCompleter } from './deepseek'

/**
 * DeepSeek Chat Completions 的真实出口：把请求体 POST 过去，取回 assistant 的文本内容。
 *
 * 密钥经 @treen/shared 的配置层读取（进程环境变量优先、其次 .env.local），缺失即抛可操作的错误。
 * 超时用 AbortSignal 兜住悬挂连接：翻译在交互链路里，一次卡死会把整条链路的响应预算吃光。
 */

const DEFAULT_ENDPOINT = 'https://api.deepseek.com'
const DEFAULT_TIMEOUT_MS = 30_000

export interface DeepSeekCompleterOptions {
  /** 显式密钥；缺省经 @treen/shared 读取 */
  apiKey?: string
  /** API 基址；缺省官方端点（测试可指向替身） */
  endpoint?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function createDeepSeekCompleter(options: DeepSeekCompleterOptions = {}): TranslateCompleter {
  const apiKey = options.apiKey ?? requireDeepSeekKey()
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch

  return async (body) => {
    const response = await fetchImpl(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!response.ok) {
      // 读响应体只为把服务端的原因带进错误信息；读不出来也不能盖过状态码本身。
      const detail = await response.text().catch(() => '')
      throw new Error(`DeepSeek 请求失败：HTTP ${response.status} ${detail.slice(0, 200)}`)
    }

    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[]
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('DeepSeek 响应缺少 choices[0].message.content')
    }
    return content
  }
}
