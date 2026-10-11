import type { OcrEngine } from '@treen/shared/translation'

/**
 * 调试页端点测试的共同夹具：假 PNG/JPEG 头、一屏三行观察与识别替身。
 * 各 spec 只保留自己真正独有的断言部件，几何与字节构造不再逐份誊抄——
 * 誊抄过的夹具会各自漂移，届时「测试挂了」分不清是行为变了还是夹具错了。
 */

export const SIZE = { width: 500, height: 300 }

/**
 * 一屏三行：正文 + 两行图源码。几何取自共享层装配单测里已被验证能检出一张图的那一屏，
 * 故渲染站侧的断言只关心「把它们拼起来了」，几何扩张本身的算法不重复校验。
 */
export const LINES = [
  { text: 'Title', box: { x: 0, y: 0, width: 60, height: 20 } },
  { text: 'graph LR', box: { x: 200, y: 100, width: 80, height: 20 } },
  { text: 'A --> B', box: { x: 200, y: 125, width: 140, height: 20 } },
]

/** 造一个只有签名与 IHDR 的 PNG 头：尺寸解析只读这两处，装配只从字节里读尺寸，不作图。 */
export function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 造一个只有 SOI 与 SOF0 的 JPEG：帧头即尺寸来源。 */
export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0xff, 0xd9,
  ])
}

export const IMAGE = `data:image/png;base64,${Buffer.from(pngHeader(SIZE.width, SIZE.height)).toString('base64')}`

/** 识别替身：按整幅图的归一化坐标交出三行观察，不碰二进制。 */
export const recognize: OcrEngine = async () => ({
  observations: LINES.map((line) => ({
    text: line.text,
    confidence: 0.9,
    boundingBox: {
      x: line.box.x / SIZE.width,
      y: line.box.y / SIZE.height,
      width: line.box.width / SIZE.width,
      height: line.box.height / SIZE.height,
    },
  })),
})
