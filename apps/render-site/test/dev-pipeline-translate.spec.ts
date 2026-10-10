import { describe, expect, it } from 'vitest'
import type { TranslateCompleter } from '@treen/shared/translation'
import { runTranslate } from '../server/utils/dev-pipeline'

/** 取回批量翻译请求里真正送出去的那批文本：门控是否生效只能在这里观察到。 */
function sentTextsOf(body: unknown): string[] {
  const messages: unknown[] = Array.isArray((body as { messages?: unknown }).messages)
    ? [...(body as { messages: unknown[] }).messages]
    : []
  const user = [...messages].reverse().find((entry) => (entry as { role?: unknown }).role === 'user')
  const content = (user as { content?: unknown } | undefined)?.content
  if (typeof content !== 'string') {
    throw new Error('请求体里没有 user content')
  }
  // buildTranslateBody 把待译数组拼在 `请翻译并按 …返回：` 之后，前缀里另有 `{"translations": …}`
  // 这段示例，故从 `{"texts"` 起切，避免切到示例那一段。
  const marker = content.indexOf('{"texts"')
  if (marker < 0) {
    throw new Error(`user content 里找不到待译数组：${content}`)
  }
  return (JSON.parse(content.slice(marker)) as { texts: string[] }).texts
}

/** 假出口：记下每次实际送译的文本，按 `译：<原文>` 作答。不发网络请求、不消耗密钥。 */
function recordingCompleter(sent: string[][]): TranslateCompleter {
  return async (body) => {
    const texts = sentTextsOf(body)
    sent.push(texts)
    return JSON.stringify({ translations: texts.map((text) => `译:${text}`) })
  }
}

describe('runTranslate', () => {
  it('中文条目被门控跳过：不进请求、以原文回填、gated 标记为真', async () => {
    const sent: string[][] = []

    const result = await runTranslate(['这是中文说明', 'Hello world'], {
      complete: recordingCompleter(sent),
    })

    expect(sent).toEqual([['Hello world']])
    expect(result.gated).toEqual([true, false])
    expect(result.translations).toEqual(['这是中文说明', '译:Hello world'])
  })

  it('整批都是中文时一次外部调用都不发', async () => {
    const sent: string[][] = []

    const result = await runTranslate(['中文一', '中文二'], { complete: recordingCompleter(sent) })

    expect(sent).toEqual([])
    expect(result.gated).toEqual([true, true])
    expect(result.translations).toEqual(['中文一', '中文二'])
  })

  it('空输入既不进请求也不报错', async () => {
    const sent: string[][] = []

    const result = await runTranslate([], { complete: recordingCompleter(sent) })

    expect(sent).toEqual([])
    expect(result).toEqual({ translations: [], gated: [] })
  })

  it('纯英文整批送译，gated 全为假', async () => {
    const sent: string[][] = []

    const result = await runTranslate(['alpha', 'beta'], { complete: recordingCompleter(sent) })

    expect(sent).toEqual([['alpha', 'beta']])
    expect(result.gated).toEqual([false, false])
    expect(result.translations).toEqual(['译:alpha', '译:beta'])
  })
})
