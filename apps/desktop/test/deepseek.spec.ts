import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BATCH_SIZE,
  buildTranslateBody,
  chunk,
  createBatchTranslator,
  parseTranslations,
  type TranslateCompleter,
} from '../src/translation/deepseek'
import { createDeepSeekCompleter } from '../src/translation/deepseek-client'

describe('chunk', () => {
  it('按批大小切分，末尾不足一批也成批', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('空输入得到空数组', () => {
    expect(chunk([], 3)).toEqual([])
  })

  it('批大小非正数即拒绝，避免无声的不前进', () => {
    expect(() => chunk([1], 0)).toThrow()
    expect(() => chunk([1], -1)).toThrow()
  })
})

describe('parseTranslations', () => {
  it('接受对象形态的 translations 数组', () => {
    expect(parseTranslations('{"translations":["A","B"]}', 2)).toEqual(['A', 'B'])
  })

  it('兼容模型直接给裸数组', () => {
    expect(parseTranslations('["A","B"]', 2)).toEqual(['A', 'B'])
  })

  it('长度与输入不一致时返回 null（触发逐条降级）', () => {
    expect(parseTranslations('{"translations":["A"]}', 2)).toBeNull()
    expect(parseTranslations('{"translations":["A","B","C"]}', 2)).toBeNull()
  })

  it('非法 JSON 或非字符串元素返回 null', () => {
    expect(parseTranslations('not json', 1)).toBeNull()
    expect(parseTranslations('{"translations":[1,2]}', 2)).toBeNull()
    expect(parseTranslations('{"other":[]}', 1)).toBeNull()
  })
})

describe('buildTranslateBody', () => {
  it('关思考、走 json_object、带上待译文本', () => {
    const body = buildTranslateBody(['你好世界', 'second line']) as {
      model: string
      thinking: { type: string }
      response_format: { type: string }
      temperature: number
      messages: { role: string; content: string }[]
    }

    expect(body.model).toBe('deepseek-flash')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(typeof body.temperature).toBe('number')
    const user = body.messages.find((message) => message.role === 'user')
    expect(user?.content).toContain('你好世界')
    expect(user?.content).toContain('second line')
  })
})

describe('createBatchTranslator', () => {
  it('空输入不发起请求', async () => {
    const complete = vi.fn<TranslateCompleter>()

    expect(await createBatchTranslator({ complete })([])).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it('单批结果按序返回', async () => {
    const complete = vi.fn<TranslateCompleter>(async () => '{"translations":["甲","乙"]}')
    const translate = createBatchTranslator({ complete })

    expect(await translate(['one', 'two'])).toEqual(['甲', '乙'])
  })

  it('超过批大小则分批请求，结果按输入序拼接', async () => {
    const complete = vi.fn<TranslateCompleter>()
    complete
      .mockResolvedValueOnce('{"translations":["a1","a2"]}')
      .mockResolvedValueOnce('{"translations":["b1"]}')
    const translate = createBatchTranslator({ complete, batchSize: 2 })

    expect(await translate(['x', 'y', 'z'])).toEqual(['a1', 'a2', 'b1'])
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('批返回长度失配时降级逐条重试', async () => {
    const complete = vi.fn<TranslateCompleter>()
    complete
      // 第一条请求（整批）返回长度不符
      .mockResolvedValueOnce('{"translations":["只有一条"]}')
      // 降级逐条：两条各请求一次
      .mockResolvedValueOnce('{"translations":["乙译"]}')
      .mockResolvedValueOnce('{"translations":["甲译"]}')
    const logger = { info: vi.fn(), warn: vi.fn() }
    const translate = createBatchTranslator({ complete, logger })

    const result = await translate(['甲', '乙'])

    expect(complete).toHaveBeenCalledTimes(3)
    expect(result).toEqual(['乙译', '甲译'])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('逐条重试后仍解析不出结果即抛错，不静默用原文顶替', async () => {
    const complete = vi.fn<TranslateCompleter>()
    complete
      .mockResolvedValueOnce('{"translations":["单条"]}') // 整批失配
      .mockResolvedValueOnce('garbage') // 逐条第 1 条失败
    const translate = createBatchTranslator({ complete })

    await expect(translate(['甲', '乙'])).rejects.toThrow()
  })

  it('默认批大小是导出的常量', () => {
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(0)
  })
})

describe('createDeepSeekCompleter', () => {
  function jsonResponse(payload: unknown, ok = true, status = 200): Response {
    return {
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response
  }

  it('向 chat/completions 发 POST，带密钥、关思考与 json_object，取回 message.content', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '{"translations":["译"]}' } }] }))
    const complete = createDeepSeekCompleter({ apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch })

    const content = await complete({ model: 'deepseek-flash' })

    expect(content).toBe('{"translations":["译"]}')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(JSON.parse(String(init.body)).model).toBe('deepseek-flash')
  })

  it('HTTP 非 2xx 时抛错并带上状态与响应体', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, false, 401))
    const complete = createDeepSeekCompleter({ apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(complete({})).rejects.toThrow(/401/)
  })

  it('响应缺少 message.content 时抛错', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }))
    const complete = createDeepSeekCompleter({ apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch })

    await expect(complete({})).rejects.toThrow()
  })
})
