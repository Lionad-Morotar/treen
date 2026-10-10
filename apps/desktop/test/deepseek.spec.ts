import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BATCH_SIZE,
  buildTranslateBody,
  chunk,
  createBatchTranslator,
  isChineseDominant,
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

  it('prompt 要求已是目标语言的条目原样返回，不改写不润色不纠错', () => {
    const body = buildTranslateBody(['hello']) as { messages: { role: string; content: string }[] }
    const system = body.messages.find((message) => message.role === 'system')

    expect(system?.content).toContain('已是简体中文')
    expect(system?.content).toContain('原样返回')
    expect(system?.content).toContain('不得改写')
  })
})

describe('isChineseDominant', () => {
  it('纯中文与汉主英辅混排判为中文：英文术语保留是常态，无需翻译', () => {
    expect(isChineseDominant('标题')).toBe(true)
    expect(isChineseDominant('实测拍网格（beats overlay）：comb 最大似然')).toBe(true)
    expect(isChineseDominant('用 React 写的 hook')).toBe(true)
    expect(isChineseDominant('version 2.0 更新说明')).toBe(true)
  })

  it('外文字母（西里尔、谚文等）计入分母，对应语种照常送译而非整批免译', () => {
    expect(isChineseDominant('The quick brown fox jumps over the lazy dog')).toBe(false)
    expect(isChineseDominant('graph LR')).toBe(false)
    expect(isChineseDominant('Настройки безопасности')).toBe(false)
    expect(isChineseDominant('설정 보기')).toBe(false)
  })

  it('含假名的行不可能是简体中文：含汉字的日语与纯假名行都送译', () => {
    expect(isChineseDominant('設定を確認してください')).toBe(false)
    expect(isChineseDominant('ごはんをたべます')).toBe(false)
  })

  it('纯数字、标点与空文本按非中文送译：误送的代价仅一次原样返回，误关则语种静默失效', () => {
    expect(isChineseDominant('2024')).toBe(false)
    expect(isChineseDominant('')).toBe(false)
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
      .mockResolvedValueOnce('{"translations":["beta 译"]}')
      .mockResolvedValueOnce('{"translations":["alpha 译"]}')
    const logger = { info: vi.fn(), warn: vi.fn() }
    const translate = createBatchTranslator({ complete, logger })

    const result = await translate(['alpha', 'beta'])

    expect(complete).toHaveBeenCalledTimes(3)
    expect(result).toEqual(['beta 译', 'alpha 译'])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('逐条重试后仍解析不出结果即抛错，不静默用原文顶替', async () => {
    const complete = vi.fn<TranslateCompleter>()
    complete
      .mockResolvedValueOnce('{"translations":["单条"]}') // 整批失配
      .mockResolvedValueOnce('garbage') // 逐条第 1 条失败
    const translate = createBatchTranslator({ complete })

    await expect(translate(['alpha', 'beta'])).rejects.toThrow()
  })

  it('默认批大小是导出的常量', () => {
    expect(DEFAULT_BATCH_SIZE).toBeGreaterThan(0)
  })
})

describe('createBatchTranslator · 语言门控', () => {
  it('整批已是中文时一次外部调用都不发，返回等长且等于原文', async () => {
    const complete = vi.fn<TranslateCompleter>()
    const logger = { info: vi.fn(), warn: vi.fn() }
    const translate = createBatchTranslator({ complete, logger })

    const texts = ['实测拍网格（beats overlay）：comb 最大似然', '标题', '你好，世界']
    expect(await translate(texts)).toEqual(texts)
    expect(complete).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('3/3'))
  })

  it('混批时只送外文条目，中文条目原位回填，等长与顺序不乱', async () => {
    const complete = vi.fn<TranslateCompleter>(async () => '{"translations":["brown fox 译文"]}')
    const translate = createBatchTranslator({ complete })

    const result = await translate(['标题', 'brown fox', '结束'])

    expect(result).toEqual(['标题', 'brown fox 译文', '结束'])
    expect(complete).toHaveBeenCalledTimes(1)
    // 请求体里只有外文条目：中文条目不进请求，省下的不只是费用，还有被模型改写漂移的风险。
    const body = complete.mock.calls[0]?.[0] as { messages: { role: string; content: string }[] }
    const user = body.messages.find((message) => message.role === 'user')
    expect(user?.content).toContain('brown fox')
    expect(user?.content).not.toContain('标题')
  })

  it('整批非拉丁外文（西里尔/谚文）不触发门控，照常送译', async () => {
    const complete = vi.fn<TranslateCompleter>(async () => '{"translations":["安全设置译","查看设置译"]}')
    const translate = createBatchTranslator({ complete })

    const texts = ['Настройки безопасности', '설정 보기']
    expect(await translate(texts)).toEqual(['安全设置译', '查看设置译'])
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('门控跳过的条目不是丢弃：唯一外文条目降级逐条仍失败时抛错，中文条目从未进请求', async () => {
    const complete = vi.fn<TranslateCompleter>()
    complete
      .mockResolvedValueOnce('garbage') // 单条批解析失败
      .mockResolvedValueOnce('garbage') // 逐条降级仍失败
    const logger = { info: vi.fn(), warn: vi.fn() }
    const translate = createBatchTranslator({ complete, logger })

    await expect(translate(['标题', 'plain english line'])).rejects.toThrow()
    // 两次请求体里都只有英文条目：中文条目连降级路径都没进。
    for (const call of complete.mock.calls) {
      const body = call[0] as { messages: { role: string; content: string }[] }
      const user = body.messages.find((message) => message.role === 'user')
      expect(user?.content).toContain('plain english line')
      expect(user?.content).not.toContain('标题')
    }
    expect(logger.warn).toHaveBeenCalled()
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
