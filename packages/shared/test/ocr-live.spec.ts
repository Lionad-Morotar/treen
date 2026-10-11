import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { macOcrEngine } from '../src/translation/mac-ocr'
import { createOcrReader } from '../src/translation/ocr'

/**
 * mac-ocr 真链路：外部进程桥接的形态（ESM 动态 import、随包二进制、ROI 归一坐标）
 * 在注入替身的单测里是结构性盲区，只有真跑一遍二进制才证明得了。
 *
 * 门控锚真实可用性而非环境存在性：fixture 不在盘（worktree/zRefs 未接入、他在别的机器）或不在 macOS 即整套跳过，
 * 二者正是这条链路能不能跑的真实前置，不是「假装可用」。fixture 用 zRefs/image.png——蓝图为端到端回放指定的样本。
 */
const fixture = fileURLToPath(new URL('../../../zRefs/image.png', import.meta.url))
const available = process.platform === 'darwin' && existsSync(fixture)

describe.skipIf(!available)('mac-ocr 真链路', () => {
  it('对真实截屏按 ROI 识别出文本，并把结果映射回选区 DIP', async () => {
    const bytes = readFileSync(fixture)
    const width = 1643
    const height = 1247
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
    const display = { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width, height } }
    const frame = { id: 'fixture', displayId: '1', size: { width, height }, dataUrl }
    // 右下半区：样本在那里确有正文，且 ROI 非全幅能顺带验证归一化换算。
    const region = { x: width / 2, y: height / 2, width: width / 2, height: height / 2 }

    const blocks = await createOcrReader({ recognize: macOcrEngine() })(frame, region, display)

    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.every((block) => block.text.trim().length > 0)).toBe(true)
    // 映射正确性：每段的落点都落在选区内（允许归一化浮点带来的一像素级溢出）。
    const epsilon = 1
    for (const block of blocks) {
      expect(block.box.x).toBeGreaterThanOrEqual(region.x - epsilon)
      expect(block.box.y).toBeGreaterThanOrEqual(region.y - epsilon)
      expect(block.box.x + block.box.width).toBeLessThanOrEqual(region.x + region.width + epsilon)
      expect(block.box.y + block.box.height).toBeLessThanOrEqual(region.y + region.height + epsilon)
    }
  }, 60_000)
})
