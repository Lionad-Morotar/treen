/**
 * 冻结态的多显示器几何换算：把全局坐标（DIP）与截屏位图（物理像素）在两个坐标系之间搬运。
 *
 * 这里只依赖结构化投影（DisplayLike / CaptureSourceLike）而非 Electron 类型，
 * 让几何逻辑能在纯 Node 下被单测覆盖——Electron 的 screen / desktopCapturer 只在
 * 适配层出现，几何本身不引入运行时依赖。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** 显示器投影：Electron `Display` 的几何与身份面。 */
export interface DisplayLike {
  /** Display.id（数字）；与 desktopCapturer 的 display_id（字符串）比对时需归一 */
  id: number
  /** DIP 单位，可为负（副屏在主屏左/上方时为负坐标） */
  bounds: Rect
  scaleFactor: number
}

/** desktopCapturer 源投影。 */
export interface CaptureSourceLike {
  id: string
  /** 若实现取到了 display_id 映射则为目标屏 id，否则为空串 */
  displayId: string
  /** 位图尺寸；实现无法给出时不填 */
  size: Size | null
}

export interface CaptureMatch<S extends CaptureSourceLike = CaptureSourceLike> {
  display: DisplayLike
  source: S
}

export interface CapturePlan<S extends CaptureSourceLike = CaptureSourceLike> {
  /** 配对成功的屏，按 displays 的入参顺序排列 */
  matches: CaptureMatch<S>[]
  /** 未找到对应源的屏；调用方据它决定降级或记录 */
  missingDisplays: DisplayLike[]
}

/**
 * 显示器在原生分辨率下的物理像素尺寸。
 * 取 ceil 而非 round：多出的半像素宁可多采一点，也不让截屏少采样后放大变糊。
 */
export function physicalPixelSize(display: DisplayLike): Size {
  return {
    width: Math.ceil(display.bounds.width * display.scaleFactor),
    height: Math.ceil(display.bounds.height * display.scaleFactor),
  }
}

/**
 * desktopCapturer 单一 thumbnailSize 的取值：所有屏物理尺寸的逐轴最大值。
 * 取最大是因为该参数对所有源是同一个边界框，取最大可保证每块屏的缩略图都不低于原生分辨率
 * （较小的屏会被放到框内，视觉无损，仅多占一点内存）。
 */
export function captureThumbnailSize(displays: readonly DisplayLike[]): Size {
  if (displays.length === 0) {
    throw new Error('无法规划截屏：未检测到任何显示器')
  }
  let width = 0
  let height = 0
  for (const display of displays) {
    const size = physicalPixelSize(display)
    width = Math.max(width, size.width)
    height = Math.max(height, size.height)
  }
  return { width, height }
}

/** 把全局 DIP 坐标换算成某窗口内的相对坐标。 */
export function toWindowPoint(global: Point, windowBounds: Rect): Point {
  return { x: global.x - windowBounds.x, y: global.y - windowBounds.y }
}

/** 把全局 DIP 矩形换算成某窗口内的相对矩形。 */
export function toWindowRect(global: Rect, windowBounds: Rect): Rect {
  return {
    x: global.x - windowBounds.x,
    y: global.y - windowBounds.y,
    width: global.width,
    height: global.height,
  }
}

/**
 * 帧位图与显示器 DIP 之间的换算比例，横纵分别给出。
 *
 * 除 scaleFactor 是错的：截屏缩略图对所有屏共用一个上界尺寸（见 captureThumbnailSize），
 * 较小的屏会被缩放填进这个上界，其位图尺寸因此与物理像素不等。用「位图尺寸 ÷ DIP 尺寸」
 * 的实测比值对这种缩放天然成立。
 */
export function frameScaleOf(display: DisplayLike, frameSize: Size): Size {
  return {
    width: frameSize.width > 0 ? frameSize.width / display.bounds.width : 0,
    height: frameSize.height > 0 ? frameSize.height / display.bounds.height : 0,
  }
}

/**
 * 显示器相对 DIP 矩形换算成帧位图的像素裁剪矩形：取整并裁到帧内。
 *
 * 返回 null 而不是一张空图：完全落在帧外、或换算退化成零面积时，调用方该放弃这次动作
 * 并出声，悄悄交出一张空图会让下游以为拿到了有效像素。
 */
export function dipRectToFrameRect(rect: Rect, display: DisplayLike, frameSize: Size): Rect | null {
  const scale = frameScaleOf(display, frameSize)
  if (scale.width <= 0 || scale.height <= 0) {
    return null
  }
  const left = Math.max(0, Math.round(rect.x * scale.width))
  const top = Math.max(0, Math.round(rect.y * scale.height))
  const right = Math.min(frameSize.width, Math.round((rect.x + rect.width) * scale.width))
  const bottom = Math.min(frameSize.height, Math.round((rect.y + rect.height) * scale.height))
  if (right - left <= 0 || bottom - top <= 0) {
    return null
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * 命中测试：哪个显示器包含该全局点。
 * 边界取半开区间 [x, x+width)，使相邻两屏的公共边不会被两块屏同时认领。
 */
export function displayContainingPoint(
  displays: readonly DisplayLike[],
  point: Point,
): DisplayLike | undefined {
  return displays.find((display) => {
    const { x, y, width, height } = display.bounds
    return point.x >= x && point.x < x + width && point.y >= y && point.y < y + height
  })
}

/**
 * 把截屏源与显示器配对。
 * display_id 是字符串而 Display.id 是数字，必须经 String() 归一后比较——直接相等判断在
 * 类型层面就该报错，运行时更会静默恒 false 导致全部屏都配不上。
 */
export function matchSourcesToDisplays<S extends CaptureSourceLike>(
  sources: readonly S[],
  displays: readonly DisplayLike[],
): CapturePlan<S> {
  const matches: CaptureMatch<S>[] = []
  const missingDisplays: DisplayLike[] = []
  for (const display of displays) {
    const source = sources.find((candidate) => candidate.displayId === String(display.id))
    if (source === undefined) {
      missingDisplays.push(display)
    } else {
      matches.push({ display, source })
    }
  }
  return { matches, missingDisplays }
}
