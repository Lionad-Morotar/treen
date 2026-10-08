import type { Rect } from '../freeze/geometry'
import type { OcrEngine } from './ocr'

/**
 * mac-ocr 的真实绑定：把归一化 ROI 交给 Apple Vision 取字。
 *
 * 走运行时动态 import：mac-ocr 是纯 ESM，且经 `fileURLToPath(new URL('../bin/mac-ocr', import.meta.url))`
 * 解析随包分发的通用二进制。若被 rolldown 打进 CJS 主进程产物，import.meta 会被替成空对象、二进制路径算错——
 * 与 get-windows 同因，故构建侧必须把它列为 external，运行时再经 import() 加载（CJS 下动态 import ESM 可用）。
 *
 * 不传 languages：默认识别器覆盖中英混排（真机样本已验），强制语言集反而会削掉其它语种；
 * 语言选择归后续设置项。
 */
export function macOcrEngine(): OcrEngine {
  return async (bytes: Uint8Array, roi: Rect) => {
    const { ocr } = await import('mac-ocr')
    const result = await ocr(bytes, {
      regionOfInterest: { x: roi.x, y: roi.y, width: roi.width, height: roi.height },
    })
    return {
      observations: result.observations.map((observation) => ({
        text: observation.text,
        confidence: observation.confidence,
        boundingBox: observation.boundingBox,
      })),
    }
  }
}
