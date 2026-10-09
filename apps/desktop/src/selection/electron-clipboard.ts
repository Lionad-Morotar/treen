import { ClipboardItem, clipboard, nativeImage } from 'electron'
import type { FreezeFrame, FreezeLogger } from '../freeze/controller'
import type { Rect } from '../freeze/geometry'

/**
 * 选区拷贝的 Electron 绑定层：把纯逻辑算出的像素矩形真的裁下来、写进系统剪贴板。
 * 与 freeze/electron-adapters.ts 同属运行时层，不写业务判断，不进单测（由真链路 smoke 兜）。
 */

/**
 * 生成「把帧的某块像素写进剪贴板」的动作。
 *
 * 三个形态要点：
 * - Electron 44 移除了 `clipboard.writeImage`，图片只能经异步剪贴板 API 写入，
 *   构造面接受 Blob 而不是 NativeImage，因此这里交出去的是 PNG 字节。
 * - 必须走 PNG：JPEG 没有 alpha 通道，透明背景会被压成黑底。
 * - `crop` 的 rect 是位图像素坐标（帧由 data URL 解出，其 scaleFactor 为 1），
 *   故 2x 屏上裁出的是 2x 像素而不是 DIP 尺寸。这一点由冒烟的像素断言守着，
 *   Electron 若再改裁剪的尺度语义会在那里报警而不是悄悄交出半分辨率的图。
 */
export function frameCropWriter(
  logger?: FreezeLogger,
): (frame: FreezeFrame, rect: Rect) => Promise<void> {
  return async (frame, rect) => {
    const image = nativeImage.createFromDataURL(frame.dataUrl)
    if (image.isEmpty()) {
      throw new Error('无法解析截屏帧：nativeImage 解码结果为空')
    }
    const cropped = image.crop(rect)
    if (cropped.isEmpty()) {
      throw new Error(`裁剪结果为空：${rect.width}×${rect.height} @ ${rect.x},${rect.y}`)
    }
    const png = cropped.toPNG()
    logger?.info(`拷贝像素 ${cropped.getSize().width}×${cropped.getSize().height}（${png.length} 字节 PNG）`)
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
    ])
  }
}

/**
 * 生成「把一份 PNG 字节写进剪贴板」的动作，供合成拷贝用。
 *
 * 与帧裁剪共用同一条写入形态（Blob + image/png），差别只在于字节从哪来：那边是本地解码裁剪，
 * 这边是覆盖窗渲染结果的抓取产物，写入面完全一致。
 */
export function pngClipboardWriter(): (png: Uint8Array) => Promise<void> {
  return async (png) => {
    if (png.length === 0) {
      throw new Error('合成拷贝：抓到的 PNG 是空的')
    }
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
    ])
  }
}
