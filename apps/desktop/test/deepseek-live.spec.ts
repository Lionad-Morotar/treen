import { describe, expect, it } from 'vitest'
import { readDeepSeekKey } from '@treen/shared'
import { createBatchTranslator } from '../src/translation/deepseek'
import { createDeepSeekCompleter } from '../src/translation/deepseek-client'

/**
 * DeepSeek 真链路：请求体形态（关思考、json_object、消息里显式要求 JSON）与响应包络的接受度，
 * 在桩 fetch 的单测里是结构性盲区——桩只会回我们预想的形状，证明不了真实端点认不认这套组合。
 *
 * 门控锚真实可用性而非环境存在性：没有密钥即整套跳过，而不是让测试假装通过。
 * 与 mac-ocr 侧的真链路测试对位，两条外部链路都有真跑一遍的覆盖。
 */
const available = readDeepSeekKey() !== undefined

describe.skipIf(!available)('DeepSeek 真链路', () => {
  it('批量翻译真实端点返回与输入等长、确为中文的译文', async () => {
    const translate = createBatchTranslator({ complete: createDeepSeekCompleter() })
    const texts = ['Hello, world.', 'The quick brown fox jumps over the lazy dog.']

    const translations = await translate(texts)

    expect(translations).toHaveLength(texts.length)
    expect(translations.every((line) => line.trim().length > 0)).toBe(true)
    // 目标是简体中文，源文是纯英文：真译出来就该含汉字，这条断言才是「链路真的通了」的证据。
    expect(translations.some((line) => /[一-鿿]/.test(line))).toBe(true)
  }, 60_000)
})
