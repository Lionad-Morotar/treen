/**
 * OCR 取字的纯逻辑与编排。
 *
 * 识别本身走注入的引擎（真实绑定在 mac-ocr.ts），这里只做三件不碰运行时的事：
 * 把锁定选区换算成归一化 ROI、把识别结果的归一化包围盒映射回显示器相对 DIP、按阅读序排列。
 * 因而本模块可在纯 Node 下被单测覆盖，识别链路另有真链路冒烟兜住。
 */

/**
 * 轴对齐矩形：左上原点 + 尺寸，单位由上下文给定（DIP 或归一化）。
 *
 * 真源在共享层的 geometry，这里再导出以保持既有 import 面不变；取字只需要结构投影，
 * 调用方（桌面帧、渲染站自有形状）按结构兼容传入即可。
 */
import type { Rect } from '../geometry'
export type { Rect }

/** 待识别的帧：OCR 只消费位图数据，源身份与位图尺寸对取字无用，故不列入契约。 */
export interface OcrFrame {
  dataUrl: string
}

/** 帧所属显示器的投影：归一化 ROI 只需要 DIP 边界，scaleFactor 与 id 用不上。 */
export interface OcrDisplay {
  bounds: Rect
}

/** 一条 OCR 文本观察。boundingBox 是归一化（0–1、左上原点）矩形，相对本次识别的 ROI。 */
export interface OcrObservation {
  text: string
  confidence: number
  boundingBox: Rect
}

/** 映射回显示器相对 DIP 的一段文本：box 是它在屏幕上的落点。 */
export interface OcrBlock {
  text: string
  confidence: number
  box: Rect
}

/** 识别引擎：吃图像字节与归一化 ROI，吐出观察列表。真实实现见 mac-ocr.ts。 */
export type OcrEngine = (bytes: Uint8Array, roi: Rect) => Promise<{ observations: OcrObservation[] }>

/**
 * 阅读序：先按 y 再按 x 排序。
 *
 * OCR 返回的观察顺序是识别器的内部次序，不是阅读次序；重建源码前必须按坐标排。
 * 排序键用包围盒左上角，同 y 用 x 定序——同一视觉行多块时先左后右。
 * 不改动入参，返回新数组。
 */
export function readingOrder<T extends { boundingBox: Rect }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const dy = a.boundingBox.y - b.boundingBox.y
    if (dy !== 0) {
      return dy
    }
    return a.boundingBox.x - b.boundingBox.x
  })
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * 把显示器相对 DIP 的选区换算成归一化 ROI。
 *
 * mac-ocr 的 ROI 取归一化左上原点、预先校验（越界或退化直接抛 RangeError），故这里主动钳到 [0,1]：
 * 帧是整屏的等比缩放，归一化坐标天然与帧的像素尺度无关，直接用「选区 ÷ 显示器 DIP 尺寸」即可。
 * 换算不出有效区域（非有限值、退化尺寸、完全落在屏外）时返回 null，交给调用方放弃而不是喂坏值。
 */
export function normalizedRoi(region: Rect, display: OcrDisplay): Rect | null {
  const { bounds } = display
  const values = [region.x, region.y, region.width, region.height, bounds.width, bounds.height]
  if (!values.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
    return null
  }
  const left = clamp01(region.x / bounds.width)
  const top = clamp01(region.y / bounds.height)
  const right = clamp01((region.x + region.width) / bounds.width)
  const bottom = clamp01((region.y + region.height) / bounds.height)
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) {
    return null
  }
  return { x: left, y: top, width, height }
}

/** 剥掉 PNG data URL 前缀取出图像字节，供识别引擎直接消费（不落盘）。 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) {
    throw new Error('截屏帧不是合法的 data URL：缺少数据段分隔符')
  }
  return Buffer.from(dataUrl.slice(comma + 1), 'base64')
}

export interface OcrReaderDeps {
  recognize: OcrEngine
}

/**
 * 生成「读一屏锁定区域」的动作。
 *
 * 输入是整幅帧 + 选区：识别引擎按 ROI 只报告选区内文字，返回的包围盒是 ROI 相对归一坐标，
 * 于是映射回 DIP 只是一次线性变换（ROI 原点 + 归一值 × ROI 尺寸），不再需要「帧实测比值」那一层。
 * 未识别到文字返回空数组（正常态，非错误）；选区换算不出有效 ROI 才抛错。
 */
export function createOcrReader(deps: OcrReaderDeps) {
  return async (frame: OcrFrame, region: Rect, display: OcrDisplay): Promise<OcrBlock[]> => {
    const roi = normalizedRoi(region, display)
    if (roi === null) {
      throw new Error(`无法识别：选区 ${JSON.stringify(region)} 换算不出有效 ROI`)
    }
    // 识别只覆盖钳制后的 ROI，映射必须用同一个矩形：若拿未钳制的 region 展开，
    // 越界选区会识别子区域、落点却按完整选区算，整片文字系统性偏移。界内时二者恒等，无行为变化。
    const { bounds } = display
    const effective: Rect = {
      x: roi.x * bounds.width,
      y: roi.y * bounds.height,
      width: roi.width * bounds.width,
      height: roi.height * bounds.height,
    }
    const { observations } = await deps.recognize(dataUrlToBytes(frame.dataUrl), roi)
    return readingOrder(observations).map((observation) => ({
      text: observation.text,
      confidence: observation.confidence,
      box: {
        x: effective.x + observation.boundingBox.x * effective.width,
        y: effective.y + observation.boundingBox.y * effective.height,
        width: observation.boundingBox.width * effective.width,
        height: observation.boundingBox.height * effective.height,
      },
    }))
  }
}
