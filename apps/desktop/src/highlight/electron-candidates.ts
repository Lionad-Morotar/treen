import { nativeImage } from 'electron'
import { detectBorders } from 'edge_det'
import type { DisplayLike, Size } from '../freeze/geometry'
import type { FreezeFrame, FreezeLogger } from '../freeze/controller'
import { buildCandidates, type BorderRect, type Candidate } from './candidates'
import { bgraToRgba } from './pixels'

/**
 * 候选区域数据源的真实绑定层：把截屏帧解成像素、跑一次边缘检测，产出候选矩形。
 * 与 freeze/electron-adapters.ts 同属 Electron 运行时层，不写业务判断，不进单测（由真链路 smoke 兜）。
 */

/**
 * edge_det 的最小面积闸门。双阈值在这类 UI 截图上几乎不改变检出数，minArea 才是主要噪声闸门
 * （实测：默认 100 在全屏 IDE 截图上出 40 条，1000 出 11 条，更接近「用户想选的块」）。
 * 标定见 .planning/wayfinder/treen/research/edge-detection-perf.md。
 */
export const DEFAULT_MIN_AREA = 1000

/** 双阈值取 edge_det 默认值；上述实测表明调它基本无效，故不作为可调项。 */
export const DEFAULT_LOW_THRESHOLD = 20
export const DEFAULT_HIGH_THRESHOLD = 60

export interface EdgeDetectionOptions {
  minArea?: number
  lowThreshold?: number
  highThreshold?: number
  logger?: FreezeLogger
}

/** 一帧截屏的边缘检测结果：位图尺寸与边界框同源于这张图，调用方不必自己对齐。 */
export interface FrameBorders {
  frameSize: Size
  borders: BorderRect[]
}

/**
 * 解码截屏帧并检出边缘边界框。
 *
 * 帧是 PNG data URL，经 nativeImage 解出的位图即物理像素（实测 getSize() 返回位图真实尺寸、
 * 不随 Retina 折半），正好是 edge_det 需要的输入分辨率。
 */
export function frameBorders(frame: FreezeFrame, options: EdgeDetectionOptions = {}): FrameBorders {
  const image = nativeImage.createFromDataURL(frame.dataUrl)
  if (image.isEmpty()) {
    throw new Error('无法解析截屏帧：nativeImage 解码结果为空')
  }
  const frameSize = image.getSize()
  if (frameSize.width <= 0 || frameSize.height <= 0) {
    throw new Error(`无法解析截屏帧：位图尺寸非法 ${frameSize.width}×${frameSize.height}`)
  }

  const bitmap = image.toBitmap()
  const expected = frameSize.width * frameSize.height * 4
  if (bitmap.length !== expected) {
    // 字节数不符说明位图与声明的尺寸不是同一份数据，继续喂给边缘检测会按错误的行宽切片。
    throw new Error(`截屏帧位图字节数 ${bitmap.length} 与 ${frameSize.width}×${frameSize.height} 不符`)
  }

  const borders = detectBorders(bgraToRgba(bitmap), frameSize.width, frameSize.height, {
    lowThreshold: options.lowThreshold ?? DEFAULT_LOW_THRESHOLD,
    highThreshold: options.highThreshold ?? DEFAULT_HIGH_THRESHOLD,
    minArea: options.minArea ?? DEFAULT_MIN_AREA,
  })
  return { frameSize, borders }
}

/** 按屏产出候选区域；冻结控制器只依赖这个签名，不触碰 Electron。 */
export type CandidateBuilder = (
  display: DisplayLike,
  frame: FreezeFrame,
) => Promise<readonly Candidate[]>

/** 边缘单路的构建器。 */
export function createEdgeCandidateBuilder(options: EdgeDetectionOptions = {}): CandidateBuilder {
  return async (display, frame) => {
    const { frameSize, borders } = frameBorders(frame, options)
    options.logger?.info(`显示器 ${display.id} 边缘检测出 ${borders.length} 条边界`)
    return buildCandidates({ display, frameSize, borders })
  }
}
