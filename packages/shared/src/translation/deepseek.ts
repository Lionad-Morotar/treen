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

/**
 * `TranslateCompleter` 的语义正名：出口本身与翻译无关，只是 chat/completions 的一跳，
 * mermaid 修复（mermaid/refine.ts）复用同一条出口。保留旧名是历史调用面不改写，新代码用此别名。
 */
export type ChatCompleter = TranslateCompleter

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
          '保持原顺序与条数不变，只输出 JSON。译文只含译文本身，不要加引号、编号或解释。' +
          `若某条目原文已是${target}，原样返回该条目，不得改写、润色、纠错或加解释。`,
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

/**
 * 简体中文目标的免译阈值：汉字数占全部字母（Unicode 字母类别）的比例下限。
 *
 * 阈值刻意向「判中文」倾斜，因为两侧代价不对称：误把外文判成中文，该条目被原文回填后永远不被
 * 翻译、也不上屏——prompt 兜底救不了没进请求的条目；误把中文判成外文，代价只是一次付费调用
 * （prompt 兜底要求模型对已是目标语言的条目原样返回）。0.25 能覆盖中文屏上的「汉主英辅混排」：
 * 像「实测拍网格（beats overlay）：comb 最大似然」（约 0.4）或「用 React 写的 hook」（恰好 0.25）
 * 这类行，英文术语保留是常态，同样无需翻译；再压低阈值只会把「version 2.0 更新说明」这类真正的
 * 中文行也送进付费调用，且每压一档都在扩大「外文被误关」的静默面。
 */
export const CHINESE_DOMINANT_RATIO = 0.25

/**
 * 判断一条文本是否已是简体中文（按汉字主导判据）。
 *
 * 含假名的行不可能是简体中文——汉字占比区分不了「中文」与「含汉字的日语」，假名检测补上这个盲区。
 * 分母是全部字母（Unicode 字母类别）而非只数拉丁字母：西里尔、谚文、阿拉伯文等字母文字计入分母后
 * 汉字占比自然掉下去，照常送译；若把它们排除在分母外，一张俄语屏会被当成「无可译内容」整批免译，
 * 翻译功能对那个语种静默失效。没有任何字母（纯数字、标点、空文本）同样按非中文送译：这类条目
 * 误送译的代价只是模型原样返回的一次调用，误判免译的代价是整个语种静默失效，宁可多送。
 *
 * 繁体中文按此判据同样免译（占比区分不了简繁）：廉价判据做不到可靠简繁区分（共用字占多数），
 * 引入转换库超出本切片边界，繁→简转换归后续切片。
 */
export function isChineseDominant(text: string): boolean {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
    return false
  }
  const letters = text.match(/\p{L}/gu)?.length ?? 0
  if (letters === 0) {
    return false
  }
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  return han / letters >= CHINESE_DOMINANT_RATIO
}

export interface BatchTranslatorDeps {
  complete: TranslateCompleter
  batchSize?: number
  logger?: TranslationLogger
}

/**
 * 生成「把一组文本翻译成本组译文」的动作：已是目标语言的条目直接以原文回填不进请求，其余分批请求，
 * 任一批返回长度与输入不一致即降级为逐条重试。
 *
 * 语言门控放在出口层而不是各调用方：选区翻译与图内节点文案共用同一个批量翻译实例，一处门控两处生效，
 * 中文屏上就不会有任何一个观察被送去重译。门控是「跳过」不是「丢弃」——返回值仍与输入等长，
 * 被跳过的条目以原文占位，调用方的对齐语义不变。整批都已达标时一次外部调用都不发，跳过量进日志留痕。
 * 判据与 TARGET_LANGUAGE（简体中文）绑定；「目标语言选择」尚未决，改目标语言时必须同步换判据。
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

  async function translateSent(texts: readonly string[]): Promise<string[]> {
    const out: string[] = []
    for (const batch of chunk(texts, batchSize)) {
      out.push(...(await translateBatch(batch)))
    }
    return out
  }

  return async (texts: readonly string[]): Promise<string[]> => {
    if (texts.length === 0) {
      return []
    }
    const out: string[] = new Array(texts.length)
    const pending: Array<{ index: number; text: string }> = []
    texts.forEach((text, index) => {
      if (isChineseDominant(text)) {
        out[index] = text
      } else {
        pending.push({ index, text })
      }
    })
    if (pending.length < texts.length) {
      deps.logger?.info(
        `语言门控：${texts.length - pending.length}/${texts.length} 条已是目标语言，原文回填，不进请求`,
      )
    }
    if (pending.length === 0) {
      return out
    }
    const translations = await translateSent(pending.map((entry) => entry.text))
    pending.forEach((entry, order) => {
      out[entry.index] = translations[order] as string
    })
    return out
  }
}
