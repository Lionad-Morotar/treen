import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { imageSizeOf, runOcr } from '../server/utils/dev-pipeline'

const fixture = fileURLToPath(new URL('../../../zRefs/image.png', import.meta.url))

/**
 * 门控锚真实可用性而非环境存在性：不在 macOS 或真机样本不在盘（zRefs 未接入、换了机器）
 * 时整套跳过——二者正是这条链路能不能跑的真实前置，假装可用只会留下一个永远绿却没验过
 * 二进制的测试。
 */
const available = process.platform === 'darwin' && existsSync(fixture)

/** 造一个只有签名与 IHDR 的 PNG 头：尺寸解析器只读这两处，故足以驱动解析分支。 */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 造一个只有 SOI 与 SOF0 的 JPEG：帧头即尺寸来源。 */
function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0xff, 0xd9,
  ])
}

describe('imageSizeOf', () => {
  it('从 PNG 的 IHDR 读出像素尺寸', () => {
    expect(imageSizeOf(pngHeader(1643, 1247))).toEqual({ width: 1643, height: 1247 })
  })

  it('从 JPEG 的 SOF0 读出像素尺寸', () => {
    expect(imageSizeOf(jpegHeader(800, 600))).toEqual({ width: 800, height: 600 })
  })

  it('认不出的格式返回 null（由调用方决定报错，不猜尺寸）', () => {
    expect(imageSizeOf(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull()
  })
})

describe.skipIf(!available)('dev OCR 真链路', () => {
  it('对真实截图跑通 mac-ocr，返回带图像像素坐标的文本块', async () => {
    const bytes = readFileSync(fixture)
    const size = imageSizeOf(bytes)
    expect(size).not.toBeNull()
    const image = `data:image/png;base64,${bytes.toString('base64')}`

    const { blocks, elapsedMs } = await runOcr(image)

    // 真跑二进制的判据：确实拿到了文本，且耗时是可测的正数量级（不是注入替身的恒零）。
    expect(blocks.length).toBeGreaterThan(0)
    expect(elapsedMs).toBeGreaterThanOrEqual(0)
    expect(blocks.every((block) => block.text.trim().length > 0)).toBe(true)

    // 坐标语义：图像像素、左上原点，且落在图像内（归一化换算允许一像素级溢出）。
    const width = size?.width ?? 0
    const height = size?.height ?? 0
    const epsilon = 1
    for (const block of blocks) {
      expect(block.box.x).toBeGreaterThanOrEqual(-epsilon)
      expect(block.box.y).toBeGreaterThanOrEqual(-epsilon)
      expect(block.box.x + block.box.width).toBeLessThanOrEqual(width + epsilon)
      expect(block.box.y + block.box.height).toBeLessThanOrEqual(height + epsilon)
      expect(block.box.width).toBeGreaterThan(0)
      expect(block.box.height).toBeGreaterThan(0)
    }

    // 阅读序由生产侧保证（先 y 后 x）：调试页按返回顺序叠加才不会跳行。
    for (let index = 1; index < blocks.length; index += 1) {
      const previous = blocks[index - 1]
      const current = blocks[index]
      expect(previous).toBeDefined()
      expect(current).toBeDefined()
      if (previous !== undefined && current !== undefined) {
        expect(current.box.y).toBeGreaterThanOrEqual(previous.box.y - epsilon)
      }
    }
  }, 60_000)
})
