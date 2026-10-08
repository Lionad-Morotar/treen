import { nativeImage } from 'electron'
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
