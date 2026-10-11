import { describe, expect, it, vi } from 'vitest'
import type { OcrEngine } from '@treen/shared/translation'
import { runPipeline, runTranslate, runTranslateRequest } from '../server/utils/dev-pipeline'

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

/**
 * 修复出口同样必须惰性装配（与翻译同一条纪律）：缺密钥在真有一张图要修时才成为错误，
 * 且被装配层吞为「落回规则候选」的诊断——图不因出口缺密钥而消失，链路不因调试页缺配置而 503 整挂。
 */
describe('未配 DEEPSEEK_KEY 时的 LLM 修复链路', () => {
  const SIZE = { width: 500, height: 300 }

  function pngHeader(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(24)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    const view = new DataView(bytes.buffer)
    view.setUint32(16, width)
    view.setUint32(20, height)
    return bytes
  }

  const IMAGE = `data:image/png;base64,${Buffer.from(pngHeader(SIZE.width, SIZE.height)).toString('base64')}`

  const recognize: OcrEngine = async () => ({
    observations: [
      { text: 'graph LR', confidence: 0.9, boundingBox: { x: 200 / SIZE.width, y: 100 / SIZE.height, width: 80 / SIZE.width, height: 20 / SIZE.height } },
      { text: 'A --> B', confidence: 0.9, boundingBox: { x: 200 / SIZE.width, y: 125 / SIZE.height, width: 140 / SIZE.width, height: 20 / SIZE.height } },
    ],
  })

  it('有图要修才问密钥；缺密钥时图走规则候选照常出来，诊断解释落回原因', async () => {
    const result = await runPipeline(
      { image: IMAGE, translateText: false },
      {
        recognize,
        render: async () => ({ svg: '<svg viewBox="0 0 100 50"></svg>', intrinsic: { width: 100, height: 50 } }),
      },
    )

    expect(result.plan.charts).toHaveLength(1)
    expect(result.diagnostics.some((entry) => entry.includes('LLM 修复失败'))).toBe(true)
  })
})
