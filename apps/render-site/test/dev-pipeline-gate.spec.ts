import { afterEach, describe, expect, it } from 'vitest'
import {
  devGateNotFound,
  isDevEnvironment,
  setDevEnvironmentOverride,
} from '../server/utils/dev-gate'
import { runOcrRequest, runPipelineRequest, runTranslateRequest } from '../server/utils/dev-pipeline'

afterEach(() => {
  setDevEnvironmentOverride(null)
})

describe('dev 路由门禁', () => {
  it('非 dev 环境下三个端点一律 404，且不触碰任何外部调用', async () => {
    setDevEnvironmentOverride(false)

    const outcomes = [
      await runOcrRequest({ image: 'data:image/png;base64,AAAA' }),
      await runTranslateRequest({ texts: ['hi'] }),
      await runPipelineRequest({ image: 'data:image/png;base64,AAAA' }),
    ]

    for (const outcome of outcomes) {
      expect(outcome.statusCode).toBe(404)
      expect(outcome.gated).toBe(true)
    }
  })

  /**
   * 门禁的意义在于「看起来像路由不存在」，所以响应体里一个字都不能说明端点性质。
   * 措辞锚成「路由未命中」那一条（比对时把路径挖掉）：任何为了排障方便加回来的说明性文案
   * （「仅在开发环境可用」之类）都会让这条变红。
   */
  it('门禁不产出任何说明端点性质的响应体', async () => {
    setDevEnvironmentOverride(false)

    expect(await runTranslateRequest({ texts: ['hi'] })).not.toHaveProperty('body')
    const notFound = devGateNotFound('/api/dev/ocr?from=scanner')
    expect(notFound.statusCode).toBe(404)
    expect(notFound.statusMessage.replace('/api/dev/ocr', '<path>')).toBe(
      'Cannot find any route matching <path>.',
    )
  })

  it('dev 环境下请求照常进入参数校验（门禁不是无条件拦截）', async () => {
    setDevEnvironmentOverride(true)

    const outcome = await runOcrRequest({ texts: [] })

    expect(outcome).toMatchObject({ gated: false, statusCode: 400, body: { error: expect.any(String) } })
  })

  it('未注入判定时回退到运行时环境判定', () => {
    setDevEnvironmentOverride(null)
    // 断言的是「回退分支存在且给出布尔值」而非具体取值：取值由打包器是否注入
    // import.meta.dev 决定，写死会让这条断言在构建产物里反过来失败。
    expect(typeof isDevEnvironment()).toBe('boolean')
  })
})
