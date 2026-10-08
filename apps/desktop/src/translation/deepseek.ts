/**
 * DeepSeek 批量翻译的纯逻辑：请求体构造、返回解析、批大小切分与长度失配的逐条降级。
 *
 * 真正的网络出口经注入（真实实现见 deepseek-client.ts），这里只做与协议形态、批处理编排有关的判断，
 * 因而可在纯 Node 下被单测覆盖，不依赖密钥或网络。
 */

/** 现役模型 ID；deepseek-chat / deepseek-reasoner 已废弃。 */
export const DEEPSEEK_MODEL = 'deepseek-flash'

/**
 * 单批发往模型的文本条数上限（provisional）：分批太小省不下固定开销，太大则单请求延迟冲破交互预算。
 * 文档无结论，须按真实输入量级压测后定档，故作为单一常量暴露。
 */
export const DEFAULT_BATCH_SIZE = 20

/** 非思考模式下 temperature 才生效，这是翻译稳定性的唯一旋钮。 */
const TEMPERATURE = 0.2

/** 翻译短文本远低于默认上限；显式设一个小值，防异常输出把延迟拉爆。 */
const MAX_TOKENS = 4096

/** 目标语言（provisional）：地图「目标语言选择」尚未决，取最常用的简中默认。 */
const TARGET_LANGUAGE = '简体中文'

export interface TranslationLogger {
  info(message: string): void
  warn(message: string): void
}

/** 把一份请求体发给模型并取回 assistant 的原始文本内容。 */
export type TranslateCompleter = (body: unknown) => Promise<string>

/** 把 items 按 size 切分；size 非正数即拒绝，避免无声的不前进。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`批大小必须是正整数，收到 ${size}`)
  }
  const batches: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size))
  }
  return batches
}

/**
 * 构造一次批量翻译请求。
 *
 * `response_format: json_object` 要求顶层是对象（不能是裸数组），故待译文本包成 `{"texts": [...]}`、
 * 要求模型回 `{"translations": [...]}`；prompt 里显式声明 JSON 是硬要求（官方文档：光设 response_format
 * 而不在消息里指示，模型可能一直吐空白）。关思考是用户明确的最快速度要求，用 thinking.type 而非 effort。
 */
export function buildTranslateBody(texts: readonly string[], target: string = TARGET_LANGUAGE): unknown {
  return {
    model: DEEPSEEK_MODEL,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          `你是翻译引擎。把用户给出的 JSON 对象里的 texts 数组逐条翻译成${target}，` +
          '保持原顺序与条数不变，只输出 JSON。译文只含译文本身，不要加引号、编号或解释。',
      },
      {
        role: 'user',
        content: `请翻译并按 {"translations": [...]} 返回：${JSON.stringify({ texts })}`,
      },
    ],
  }
}

/**
 * 从模型返回里解出等长的译文数组。解析不出或长度不符即返回 null，由调用方降级逐条。
 *
 * 兼容裸数组是为了防模型漂移：json_object 下正常返回对象，但个别实现会直接给数组，
 * 两种都接受比判死一种更稳。元素必须是字符串——`{"translations":[1,2]}` 这类不能当译文用。
 */
export function parseTranslations(content: string, expected: number): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  let candidate: unknown = null
  if (Array.isArray(parsed)) {
    candidate = parsed
  } else if (parsed !== null && typeof parsed === 'object') {
    const inner = (parsed as { translations?: unknown }).translations
    if (Array.isArray(inner)) {
      candidate = inner
    }
  }
  if (!Array.isArray(candidate)) {
    return null
  }
  const list: unknown[] = candidate
  if (list.length !== expected || !list.every((item: unknown) => typeof item === 'string')) {
    return null
  }
  return list as string[]
}

export interface BatchTranslatorDeps {
  complete: TranslateCompleter
  batchSize?: number
  logger?: TranslationLogger
}

/**
 * 生成「把一组文本翻译成本组译文」的动作：分批请求，任一批返回长度与输入不一致即降级为逐条重试。
 *
 * 降级是整批重来（逐条各发一次），而不是丢弃或补齐：长度失配意味着整批的对齐已不可信，逐条能保证
 * 每条译文与原文一一对应。逐条若仍解析不出结果，说明链路真的坏了，抛错让上层收进日志，不静默用原文顶替。
 */
export function createBatchTranslator(deps: BatchTranslatorDeps) {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE

  async function translateOneByOne(texts: readonly string[]): Promise<string[]> {
    const out: string[] = []
    for (const text of texts) {
      const parsed = parseTranslations(await deps.complete(buildTranslateBody([text])), 1)
      if (parsed === null) {
        throw new Error(`逐条翻译仍无法解析出结果：${text.slice(0, 40)}`)
      }
      out.push(parsed[0] as string)
    }
    return out
  }

  async function translateBatch(texts: readonly string[]): Promise<string[]> {
    const parsed = parseTranslations(await deps.complete(buildTranslateBody(texts)), texts.length)
    if (parsed !== null) {
      return parsed
    }
    deps.logger?.warn(`批量翻译返回与输入不一致（期望 ${texts.length} 条），降级逐条重试`)
    return translateOneByOne(texts)
  }

  return async (texts: readonly string[]): Promise<string[]> => {
    if (texts.length === 0) {
      return []
    }
    const out: string[] = []
    for (const batch of chunk(texts, batchSize)) {
      out.push(...(await translateBatch(batch)))
    }
    return out
  }
}
