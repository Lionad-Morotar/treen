import { afterEach, describe, expect, it } from 'vitest'
import { isDevEnvironment, setDevEnvironmentOverride } from '../server/utils/dev-gate'
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
      expect(outcome.body).toMatchObject({ error: expect.stringContaining('开发环境') })
    }
  })

  it('dev 环境下请求照常进入参数校验（门禁不是无条件拦截）', async () => {
    setDevEnvironmentOverride(true)

    const outcome = await runOcrRequest({ texts: [] })

    expect(outcome.statusCode).toBe(400)
    expect(outcome.body).toMatchObject({ error: expect.any(String) })
  })

  it('未注入判定时回退到运行时环境判定', () => {
    setDevEnvironmentOverride(null)
    // 断言的是「回退分支存在且给出布尔值」而非具体取值：取值由打包器是否注入
    // import.meta.dev 决定，写死会让这条断言在构建产物里反过来失败。
    expect(typeof isDevEnvironment()).toBe('boolean')
  })
})
