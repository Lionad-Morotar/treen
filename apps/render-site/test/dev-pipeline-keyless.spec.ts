import { describe, expect, it, vi } from 'vitest'
import { runTranslate, runTranslateRequest } from '../server/utils/dev-pipeline'

/**
 * 本仓 .env.local 带着真密钥，单测进程因此恒为「已配置」，而「未配密钥」恰恰是要覆盖的分支。
 * 故把唯一的取钥入口换成恒定缺失，其余导出照旧（`importOriginal` 展开，避免为了一个函数
 * 把整个共享层的导出面裁掉）。
 */
vi.mock('@treen/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@treen/shared')>()),
  readDeepSeekKey: () => undefined,
}))

/**
 * 出口必须懒装配。
 *
 * 真实出口的构造要读 DEEPSEEK_KEY、缺即 503；而空输入与「全是目标语言」的批次一次外部调用
 * 都不发。若在参数位急切构造，纯 OCR 之类压根不碰翻译的流程会跟着一起 503。
 */
describe('未配 DEEPSEEK_KEY 时的翻译出口', () => {
  it('空输入照常 200 空结果，不因缺密钥 503', async () => {
    const outcome = await runTranslateRequest({ texts: [] })

    expect(outcome).toMatchObject({
      gated: false,
      statusCode: 200,
      body: { translations: [], gated: [] },
    })
  })

  it('整批已是目标语言、一次调用都不发时不问密钥', async () => {
    await expect(runTranslate(['中文一', '中文二'])).resolves.toEqual({
      translations: ['中文一', '中文二'],
      gated: [true, true],
    })
  })

  // 反向锚：确有文本要译时才去要密钥。少了这条，上面两条可能只是被 mock 蒙过去了。
  it('真有文本要译时才报缺密钥', async () => {
    await expect(runTranslate(['hello'])).rejects.toMatchObject({ statusCode: 503 })
  })
})
