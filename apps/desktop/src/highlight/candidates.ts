/**
 * 候选区域（悬停高亮与后续框选的数据源）的纯逻辑：把两路来源归一化到同一种坐标，
 * 并按「越具体越优先」排出层叠次序。
 *
 * 坐标约定：覆盖窗是显示器 bounds 大小的窗口，其内 CSS px 即 DIP，窗口原点即显示器左上角。
 * 因此候选矩形一律用「显示器相对 DIP」表达，可原样作为绝对定位元素的 left/top/width/height；
 * 两路来源各自的原始坐标系（边缘是位图物理像素、系统窗口是全局 DIP）都在这里被抹平。
 *
 * 层叠次序即选中策略：候选取自图像边缘，天然是嵌套的（整窗里套着编辑器、编辑器里套着代码块）。
 * 「当前命中的候选区域」取最具体的那个，故小矩形必须叠在大矩形之上；本模块只负责排出次序，
 * 让渲染层用 z-index 直接兑现，判定本身交给浏览器自身的命中测试（见 overlay.html）。
 */
import { intersectRects } from '@treen/shared/geometry'
import type { DisplayLike, Rect, Size } from '../freeze/geometry'

// 交集的真源在共享层（覆盖布局与渲染站同用），这里再导出的目的是本模块的既有引用方不必改 import。
export { intersectRects }

/** edge_det 检出的边界框：坐标是截屏位图的物理像素，原点在图像左上角。 */
export interface BorderRect {
  x: number
  y: number
  w: number
  h: number
}

/** 系统窗口投影：几何取全局 DIP，随窗口枚举器给出。 */
export interface SystemWindowLike {
  bounds: Rect
  /** 窗口所属应用的 bundle id；取不到时为 null/undefined，此时不过滤应用身份 */
  bundleId?: string | null
  /** 窗口所属进程 pid，用于剔除本应用自身（冻结覆盖层本身也是窗口） */
  processId?: number | null
}

/** 候选区域来源：图像边缘 / 系统窗口。双路合成后仍保留来源，供排查与渲染层标注。 */
export type CandidateSource = 'edge' | 'window'

/** 一条候选区域，坐标是显示器相对 DIP。 */
export interface Candidate extends Rect {
  source: CandidateSource
}

/**
 * 候选的最小边长（DIP）。细于两根像素的矩形选不中、也看不清高亮，只会制造噪声。
 */
export const MIN_CANDIDATE_EXTENT = 2

/**
 * 候选的边长上限（DIP）。真实窗口不会到这个量级，出现即是窗口枚举器的哨兵值
 * （macOS 侧用 30000×30000 置于负坐标表示「无窗口」）。必须挡在裁剪之前：
 * 这种矩形裁到显示器边界后正好等于整块屏，会让屏幕上任意位置都命中它，
 * 「鼠标离开所有候选时无高亮」再也无法达成。
 */
export const MAX_CANDIDATE_EXTENT = 20000

/**
 * 归入系统 UI 层的 bundle id，不是用户会去选的窗口。
 * macOS 的窗口枚举会把登录窗、Dock、菜单栏等一并列出，且登录窗常以整屏尺寸出现——
 * 若不过滤，它就成了覆盖全屏的候选，屏幕再无「无候选」区域。
 *
 * 拼写取自磁盘上各 .app 的 Info.plist：这套 id 的大小写没有统一规律（controlcenter 全小写、
 * WindowManager 是驼峰、systemuiserver 又是全小写），照抄文档或凭印象写会静默失配。
 */
export const SYSTEM_UI_BUNDLE_IDS: readonly string[] = [
  'com.apple.loginwindow',
  'com.apple.dock',
  'com.apple.WindowManager',
  'com.apple.controlcenter',
  'com.apple.notificationcenterui',
  'com.apple.systemuiserver',
  'com.apple.Spotlight',
  'com.apple.screencaptureui',
  'com.apple.ScreenSaver.Engine',
]

const SYSTEM_UI_BUNDLE_ID_SET = new Set(SYSTEM_UI_BUNDLE_IDS.map((id) => id.toLowerCase()))

/**
 * bundle id 由各进程自行声明，大小写不作保证，比对一律折成小写。
 * 上面那串拼写是给人看的凭证，判定不能依赖它逐字节正确。
 */
export function isSystemUiBundleId(bundleId: string): boolean {
  return SYSTEM_UI_BUNDLE_ID_SET.has(bundleId.toLowerCase())
}

/** 判定一条矩形是否值得成为候选：有限数值、两个方向都够大、且不超过荒谬量级。 */
function isPlausibleRect(rect: Rect): boolean {
  const { x, y, width, height } = rect
  if (![x, y, width, height].every(Number.isFinite)) {
    return false
  }
  if (width < MIN_CANDIDATE_EXTENT || height < MIN_CANDIDATE_EXTENT) {
    return false
  }
  return width <= MAX_CANDIDATE_EXTENT && height <= MAX_CANDIDATE_EXTENT
}

/**
 * 把 edge_det 的物理像素边界换算成显示器相对 DIP。
 *
 * 换算不除 scaleFactor，而是用「显示器 DIP 尺寸 ÷ 位图尺寸」的实测比值：截屏缩略图是
 * 所有屏共用一个上界尺寸（见 captureThumbnailSize），较小的屏会被缩放填进这个上界，
 * 其位图尺寸因此与物理像素不等；比值法对这种缩放天然成立，除 scaleFactor 则会整体偏大。
 */
export function edgeCandidates(
  display: DisplayLike,
  frameSize: Size,
  borders: readonly BorderRect[],
): Candidate[] {
  // 与 geometry.frameScaleOf 是同一个比值的两个方向：这里要「DIP / 像素」，直接除出来即可。
  // 写成它的倒数（1 / frameScaleOf(...)）会让 1.5 这类比值损失精度，实测 2880×1620 的帧
  // 换算出的 1920 会变成 1919.9999999999998，坐标断言随即崩掉。
  const scaleX = frameSize.width > 0 ? display.bounds.width / frameSize.width : 0
  const scaleY = frameSize.height > 0 ? display.bounds.height / frameSize.height : 0
  if (scaleX <= 0 || scaleY <= 0) {
    return []
  }

  const candidates: Candidate[] = []
  for (const border of borders) {
    const rect: Rect = {
      x: border.x * scaleX,
      y: border.y * scaleY,
      width: border.w * scaleX,
      height: border.h * scaleY,
    }
    if (isPlausibleRect(rect)) {
      candidates.push({ ...rect, source: 'edge' })
    }
  }
  return candidates
}

/** 系统窗口选项。 */
export interface WindowCandidateOptions {
  /** 剔除该进程的窗口（本应用自己的覆盖层也是窗口，不能成为候选） */
  excludeProcessId?: number
}

/**
 * 把系统窗口矩形裁到显示器范围内，得到该屏的窗口候选。
 *
 * 裁剪而非丢弃：窗口可以横跨多屏，每块屏只该拿到落在自己范围内的那一部分。
 * 身份过滤（系统 UI 层、本应用自身）与量级过滤（哨兵值）都在裁剪之前完成。
 */
export function windowCandidates(
  display: DisplayLike,
  windows: readonly SystemWindowLike[],
  options: WindowCandidateOptions = {},
): Candidate[] {
  const { excludeProcessId } = options

  const candidates: Candidate[] = []
  for (const win of windows) {
    if (excludeProcessId !== undefined && win.processId === excludeProcessId) {
      continue
    }
    if (win.bundleId !== null && win.bundleId !== undefined && isSystemUiBundleId(win.bundleId)) {
      continue
    }
    if (!isPlausibleRect(win.bounds)) {
      continue
    }
    const clipped = intersectRects(win.bounds, display.bounds)
    if (!isPlausibleRect(clipped)) {
      continue
    }
    candidates.push({
      x: clipped.x - display.bounds.x,
      y: clipped.y - display.bounds.y,
      width: clipped.width,
      height: clipped.height,
      source: 'window',
    })
  }
  return candidates
}

/**
 * 排出层叠次序：面积大的在前、小的在后——渲染层按下标递增赋 z-index，于是小矩形叠在大矩形之上，
 * 命中测试取到的是最具体的一条。同面积时按左上角坐标兜底排序，保证同一输入产生同一输出。
 */
export function orderCandidates(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    const areaDiff = b.width * b.height - a.width * a.height
    if (areaDiff !== 0) {
      return areaDiff
    }
    if (a.y !== b.y) {
      return a.y - b.y
    }
    return a.x - b.x
  })
}

/** 合成候选区域的输入：两路来源都可缺省，缺省即该路不参与。 */
export interface CandidateInput {
  display: DisplayLike
  /** 截屏位图尺寸；只有边缘路需要 */
  frameSize?: Size
  borders?: readonly BorderRect[]
  windows?: readonly SystemWindowLike[]
  excludeProcessId?: number
}

/** 双路合成候选区域并排好层叠次序。这是候选区域对外的唯一入口。 */
export function buildCandidates(input: CandidateInput): Candidate[] {
  const parts: Candidate[] = []
  if (input.borders !== undefined && input.frameSize !== undefined) {
    parts.push(...edgeCandidates(input.display, input.frameSize, input.borders))
  }
  if (input.windows !== undefined) {
    parts.push(
      ...windowCandidates(input.display, input.windows, {
        excludeProcessId: input.excludeProcessId,
      }),
    )
  }
  return orderCandidates(parts)
}
