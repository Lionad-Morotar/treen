import { describe, expect, it } from 'vitest'
import { RENDER_SITE_ORIGIN, RENDER_SITE_ROUTES } from '@treen/ipc'
import { createRenderSiteClient } from '../src/render-site/client'

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

/** fetch 参数元组：直接从 fetch 自身取，不手写 RequestInfo 之类的全局名。 */
type FetchArgs = Parameters<typeof fetch>

/** 形状与 fetch 一致的替身：把每次调用如实记进 calls，断言不依赖 mock 的松散元组类型。 */
function fetchStub(status: number, body: unknown): { impl: typeof fetch; calls: FetchArgs[] } {
  const calls: FetchArgs[] = []
  const impl = async (...args: FetchArgs): Promise<Response> => {
    calls.push(args)
    return jsonResponse(status, body)
  }
  return { impl, calls }
}

describe('createRenderSiteClient', () => {
  it('POST 到契约的渲染端点，带 {source} 请求体，取回 SVG 与固有尺寸', async () => {
    const { impl, calls } = fetchStub(200, { svg: '<svg/>', width: 360, height: 59 })

    const render = createRenderSiteClient({ fetchImpl: impl })
    const result = await render('graph LR\n  A --> B')

    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]!
    expect(url).toBe(`${RENDER_SITE_ORIGIN}${RENDER_SITE_ROUTES.render}`)
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ source: 'graph LR\n  A --> B' })
    expect(result).toEqual({ svg: '<svg/>', intrinsic: { width: 360, height: 59 } })
  })

  it('站址可注入（测试指向替身）', async () => {
    const { impl, calls } = fetchStub(200, { svg: '<svg/>', width: 1, height: 1 })

    const render = createRenderSiteClient({ origin: 'http://127.0.0.1:9999', fetchImpl: impl })
    await render('graph LR')

    expect(calls[0]?.[0]).toBe(`http://127.0.0.1:9999${RENDER_SITE_ROUTES.render}`)
  })

  it('非 2xx 抛错并带上服务端 error 文本', async () => {
    const { impl } = fetchStub(422, { error: 'mermaid 渲染失败：Parse error' })

    const render = createRenderSiteClient({ fetchImpl: impl })

    await expect(render('bad')).rejects.toThrow(/Parse error/)
  })

  it('响应不是 {svg,width,height} 形态时抛错', async () => {
    const { impl } = fetchStub(200, { svg: '<svg/>' })

    const render = createRenderSiteClient({ fetchImpl: impl })

    await expect(render('graph LR')).rejects.toThrow(/svg, width, height/)
  })

  it('尺寸非正数视为无效响应', async () => {
    const { impl } = fetchStub(200, { svg: '<svg/>', width: 0, height: 10 })

    const render = createRenderSiteClient({ fetchImpl: impl })

    await expect(render('graph LR')).rejects.toThrow(/svg, width, height/)
  })
})
