import { nativeImage, type NativeImage } from 'electron'
import { detectBorders } from 'edge_det'
import type { DisplayLike, Size } from '../freeze/geometry'
import type { FreezeFrame, FreezeLogger } from '../freeze/controller'
import { buildCandidates, type BorderRect, type Candidate, type SystemWindowLike } from './candidates'
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

/**
 * 送去边缘检测的工作分辨率上限（长边像素）。
 *
 * detectBorders 是同步 WASM 调用，主进程要为它停住，耗时可观地随像素数线性上升：
 * 实测本机 Retina 全屏帧 4112×2658（10.9MP）要 929ms，6K 屏更久；研究文档标定的 213ms
 * 只覆盖 2MP 样本，真实帧是它的 5 倍多，等于把「标定值」当成了下界。
 * 把长边压到 2048（约 2MP）后，同一帧的检测降到约 120ms、含缩放搬运合计约 135ms，
 * 且检出矩形与全分辨率逐条一致（坐标差 ≤1px，见 zRefs 探针与冒烟）。
 * 于是标定样本重新成为耗时上界，成本不再随显示器尺寸放大。
 */
export const MAX_DETECT_EXTENT = 2048

/**
 * 决定送去检测的图：长边超限就等比缩到上限，否则原样。
 *
 * 缩放发生在检测输入侧而不是候选矩形侧，是为了让坐标换算自动成立——候选矩形由
 * `display.bounds ÷ 位图尺寸` 的实测比值还原（见 edgeCandidates），位图小了一半，
 * 比值就大一倍，DIP 坐标不受影响。
 */
function detectionImage(image: NativeImage): { image: NativeImage; factor: number } {
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= MAX_DETECT_EXTENT) {
    return { image, factor: 1 }
  }
  const factor = MAX_DETECT_EXTENT / longest
  const resized = image.resize({
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
    quality: 'good',
  })
  // 缩放失败时退回全分辨率：慢一点总好过用一张空图换算出满屏错位候选。
  return resized.isEmpty() ? { image, factor: 1 } : { image: resized, factor }
}

export interface EdgeDetectionOptions {
  minArea?: number
  lowThreshold?: number
  highThreshold?: number
  logger?: FreezeLogger
}

/** 一帧截屏的边缘检测结果：检测所用位图的尺寸与边界框同源于这张图，调用方不必自己对齐。 */
export interface FrameBorders {
  /** 送去检测的位图尺寸（可能已按 MAX_DETECT_EXTENT 缩过），边界框坐标以它为基准 */
  frameSize: Size
  borders: BorderRect[]
}

/**
 * 解码截屏帧并检出边缘边界框。
 *
 * 帧是 PNG data URL，经 nativeImage 解出的位图即物理像素（实测 getSize() 返回位图真实尺寸、
 * 不随 Retina 折半），但超限时会先缩到 MAX_DETECT_EXTENT 再送检；返回的 frameSize 始终是
 * 实际送检那张图的尺寸，调用方据它换算坐标即可，不必关心是否缩过。
 */
export function frameBorders(frame: FreezeFrame, options: EdgeDetectionOptions = {}): FrameBorders {
  const decoded = nativeImage.createFromDataURL(frame.dataUrl)
  if (decoded.isEmpty()) {
    throw new Error('无法解析截屏帧：nativeImage 解码结果为空')
  }
  const decodedSize = decoded.getSize()
  if (decodedSize.width <= 0 || decodedSize.height <= 0) {
    throw new Error(`无法解析截屏帧：位图尺寸非法 ${decodedSize.width}×${decodedSize.height}`)
  }

  const { image, factor } = detectionImage(decoded)
  const frameSize = image.getSize()
  const bitmap = image.toBitmap()
  const expected = frameSize.width * frameSize.height * 4
  if (bitmap.length !== expected) {
    // 字节数不符说明位图与声明的尺寸不是同一份数据，继续喂给边缘检测会按错误的行宽切片。
    throw new Error(`截屏帧位图字节数 ${bitmap.length} 与 ${frameSize.width}×${frameSize.height} 不符`)
  }

  const borders = detectBorders(bgraToRgba(bitmap), frameSize.width, frameSize.height, {
    lowThreshold: options.lowThreshold ?? DEFAULT_LOW_THRESHOLD,
    highThreshold: options.highThreshold ?? DEFAULT_HIGH_THRESHOLD,
    // minArea 是长度量纲（实测同一构图在 1x/0.5x/0.25x 下的翻越点为 2774/1374/674，随线性比例变化），
    // 因此要随缩放比例同步收缩：否则降采样后每条边界的周长等比变短，真实候选会整批落选。
    minArea: Math.round((options.minArea ?? DEFAULT_MIN_AREA) * factor),
  })
  return { frameSize, borders }
}

/** 按屏产出候选区域；冻结控制器只依赖这个签名，不触碰 Electron。 */
export type CandidateBuilder = (
  display: DisplayLike,
  frame: FreezeFrame,
) => Promise<readonly Candidate[]>

/** 系统窗口来源；真实实现走窗口枚举器，测试替身可直接注入。 */
export interface SystemWindowSource {
  list(): Promise<readonly SystemWindowLike[]>
}

/**
 * macOS 系统窗口枚举。
 *
 * 走 get-windows：在 macOS 侧它是一个随包分发的通用二进制，经子进程调用，因此用动态 import
 * （顺带解决 CJS 主进程加载纯 ESM 依赖的形态问题）。
 * 显式关掉辅助功能权限检查：枚举只需要窗口几何（与截屏同属屏幕录制权限范畴），
 * 不取 url 就不会为这一路候选多要一项系统授权。
 */
export function createSystemWindowSource(): SystemWindowSource {
  return {
    async list() {
      const { openWindows } = await import('get-windows')
      const windows = await openWindows({ accessibilityPermission: false, screenRecordingPermission: true })
      return windows.map((window) => ({
        bounds: window.bounds,
        bundleId: window.platform === 'macos' ? window.owner.bundleId : null,
        processId: window.owner.processId,
      }))
    },
  }
}

export interface CandidateBuilderOptions extends EdgeDetectionOptions {
  windows?: SystemWindowSource
  /** 剔除该进程的窗口，缺省是本应用自身（覆盖层也是窗口，不能成为候选） */
  excludeProcessId?: number
}

/**
 * 双路合成的候选区域构建器：边缘检测给「肉眼可见的块」，系统窗口给「视觉检测不到的纯色/无边框窗」。
 * 后者的枚举要经外部二进制与系统权限，取不到只损失一路候选，边缘路照常出结果，故单独兜住异常。
 */
export function createCandidateBuilder(options: CandidateBuilderOptions = {}): CandidateBuilder {
  const windows = options.windows ?? createSystemWindowSource()
  const excludeProcessId = options.excludeProcessId ?? process.pid

  return async (display, frame) => {
    const { frameSize, borders } = frameBorders(frame, options)

    let windowRects: readonly SystemWindowLike[] = []
    try {
      windowRects = await windows.list()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      options.logger?.warn(`系统窗口枚举失败，本次只用边缘路：${reason}`)
    }

    options.logger?.info(
      `显示器 ${display.id} 候选输入：边缘 ${borders.length} 条、系统窗口 ${windowRects.length} 个`,
    )
    return buildCandidates({ display, frameSize, borders, windows: windowRects, excludeProcessId })
  }
}
