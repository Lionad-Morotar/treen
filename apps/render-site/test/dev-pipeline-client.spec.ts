import { describe, expect, it } from 'vitest'
import { RENDER_SITE_DEV_ROUTES } from '@treen/ipc/routes'
import {
  callOcr,
  callSample,
  callSamples,
  callTranslate,
  devEndpointHint,
} from '../app/utils/dev-pipeline-client'

interface RecordedCall {
  url: string
  method: string | undefined
  body: unknown
}

/** 替掉 fetch：既给出可断言的请求记录，也免得单测真去打计费的外部翻译 API。 */
function fakeFetch(status: number, payload: string) {
  const calls: RecordedCall[] = []
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: input,
      method: init?.method,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    })
    return new Response(payload, { status })
  }
  return { calls, fetchImpl }
}

const OCR_BODY = JSON.stringify({
  blocks: [{ text: 'Hello', confidence: 0.91, box: { x: 1, y: 2, width: 3, height: 4 } }],
  elapsedMs: 2100,
})

describe('dev 端点调用', () => {
  it('OCR 打到契约常量给出的路径，而不是页面自带的字面路径', async () => {
    const { calls, fetchImpl } = fakeFetch(200, OCR_BODY)

    const result = await callOcr('data:image/png;base64,AAAA', { fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: RENDER_SITE_DEV_ROUTES.ocr,
      method: 'POST',
      body: { image: 'data:image/png;base64,AAAA' },
    })
    expect(result).toMatchObject({ ok: true })
  })

  it('翻译把条目原样交出去，并带回 gated 标记', async () => {
    const { calls, fetchImpl } = fakeFetch(
      200,
      JSON.stringify({ translations: ['你好', '世界'], gated: [false, true] }),
    )

    const result = await callTranslate(['hello', '世界'], { fetchImpl })

    expect(calls[0]).toMatchObject({
      url: RENDER_SITE_DEV_ROUTES.translate,
      body: { texts: ['hello', '世界'] },
    })
    expect(result).toMatchObject({
      ok: true,
      data: { translations: ['你好', '世界'], gated: [false, true] },
    })
  })

  it('样本清单打 GET，空目录也走 200 空列表而非错误分支', async () => {
    const { calls, fetchImpl } = fakeFetch(200, JSON.stringify({ root: null, samples: [] }))

    const result = await callSamples({ fetchImpl })

    expect(calls[0]).toMatchObject({ url: RENDER_SITE_DEV_ROUTES.samples, method: 'GET' })
    expect(result).toMatchObject({ ok: true, data: { root: null, samples: [] } })
  })

  it('样本名按 URL 段编码后再拼：名字含斜杠不能被当成路径分段', async () => {
    const { calls, fetchImpl } = fakeFetch(
      200,
      JSON.stringify({ name: 'bug-261010/orig.png', mime: 'image/png', base64: 'AAAA' }),
    )

    await callSample('bug-261010/orig.png', { fetchImpl })

    expect(calls[0]).toMatchObject({
      url: `${RENDER_SITE_DEV_ROUTES.samples}/bug-261010%2Forig.png`,
    })
  })

  /**
   * 原始响应体是排障的唯一依据：面板必须原样呈现服务端吐出的字节，
   * 任何「友好提示」都会盖掉 415/400 里那条真正说明了原因的文案。
   */
  it('失败时把服务端响应体逐字节交出，不改写不截断', async () => {
    const raw = '{"error":"读不出图像尺寸：目前只支持 PNG 与 JPEG"}'
    const { fetchImpl } = fakeFetch(415, raw)

    const result = await callOcr('data:image/webp;base64,AAAA', { fetchImpl })

    expect(result).toMatchObject({ ok: false, status: 415 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.raw).toBe(raw)
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('非 JSON 的响应体（如 Nitro 默认错误页）也原样交出', async () => {
    const { fetchImpl } = fakeFetch(404, '<!DOCTYPE html><html>404</html>')

    const result = await callTranslate(['hi'], { fetchImpl })

    expect(result).toMatchObject({ ok: false, status: 404 })
    if (!result.ok) {
      expect(result.raw).toBe('<!DOCTYPE html><html>404</html>')
    }
  })

  it('取不到响应体时不抛错，退化为空串而不是把面板打崩', async () => {
    const fetchImpl = async (): Promise<Response> => {
      throw new Error('network down')
    }

    const result = await callOcr('data:image/png;base64,AAAA', { fetchImpl })

    expect(result).toMatchObject({ ok: false, status: 0 })
  })
})

describe('dev 端点缺失的提示', () => {
  /**
   * 生产产物里 dev 端点一律 404，那不是故障而是预期；提示必须说清这一点，
   * 否则排障的人会去查一个并没有坏的服务。
   */
  it('404 提示指向 dev-only，而不是渲染成服务异常', () => {
    expect(devEndpointHint(404)).toContain('dev')
  })

  it('其它状态码没有额外提示，避免用一句万能文案盖掉真实原因', () => {
    expect(devEndpointHint(200)).toBeNull()
    expect(devEndpointHint(415)).toBeNull()
    expect(devEndpointHint(500)).toBeNull()
  })
})
