import { describe, expect, it } from 'vitest'
import {
  captureThumbnailSize,
  dipRectToFrameRect,
  displayContainingPoint,
  frameScaleOf,
  matchSourcesToDisplays,
  physicalPixelSize,
  toWindowPoint,
  toWindowRect,
  type CaptureSourceLike,
  type DisplayLike,
} from '../src/freeze/geometry'

// 主屏在原点，副屏在主屏左侧（macOS 上副屏 x 为负数）——覆盖负坐标与混合 DPR 两种形态。
const primary: DisplayLike = {
  id: 1,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
}
const secondary: DisplayLike = {
  id: 3,
  scaleFactor: 1,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
}

function source(displayId: string, id = `src-${displayId}`): CaptureSourceLike {
  return { id, displayId, size: { width: 100, height: 100 } }
}

describe('physicalPixelSize', () => {
  it('applies the display scale factor to DIP bounds', () => {
    expect(physicalPixelSize(primary)).toEqual({ width: 2880, height: 1800 })
  })

  it('keeps 1x displays at their DIP size', () => {
    expect(physicalPixelSize(secondary)).toEqual({ width: 1920, height: 1080 })
  })

  it('rounds non-integer scale factors up so the capture never under-samples', () => {
    const fractional: DisplayLike = {
      id: 9,
      scaleFactor: 1.5,
      bounds: { x: 0, y: 0, width: 1001, height: 667 },
    }
    expect(physicalPixelSize(fractional)).toEqual({ width: 1502, height: 1001 })
  })
})

describe('captureThumbnailSize', () => {
  it('takes the largest physical size across all displays', () => {
    expect(captureThumbnailSize([primary, secondary])).toEqual({ width: 2880, height: 1800 })
  })

  it('uses the single display size when only one is present', () => {
    expect(captureThumbnailSize([secondary])).toEqual({ width: 1920, height: 1080 })
  })

  it('throws a descriptive error when there is nothing to capture', () => {
    expect(() => captureThumbnailSize([])).toThrow(/显示器/)
  })
})

describe('toWindowPoint', () => {
  it('returns the same point for a window anchored at the origin', () => {
    expect(toWindowPoint({ x: 100, y: 50 }, primary.bounds)).toEqual({ x: 100, y: 50 })
  })

  it('translates global points into a window with negative origin', () => {
    expect(toWindowPoint({ x: -1800, y: 20 }, secondary.bounds)).toEqual({ x: 120, y: 20 })
  })
})

describe('toWindowRect', () => {
  it('translates a global rect into window-relative coordinates', () => {
    expect(toWindowRect({ x: -1900, y: -10, width: 100, height: 40 }, secondary.bounds)).toEqual({
      x: 20,
      y: -10,
      width: 100,
      height: 40,
    })
  })
})

describe('displayContainingPoint', () => {
  it('finds the primary display for points inside it', () => {
    expect(displayContainingPoint([primary, secondary], { x: 50, y: 50 })).toBe(primary)
  })

  it('finds a left-side display for negative coordinates', () => {
    expect(displayContainingPoint([primary, secondary], { x: -100, y: 50 })).toBe(secondary)
  })

  it('returns undefined for points outside every display', () => {
    expect(displayContainingPoint([primary, secondary], { x: 9000, y: 9000 })).toBeUndefined()
  })

  it('treats display edges as half-open so adjacent displays never both claim a point', () => {
    // x=1440 是主屏右开边界，副屏在左侧也未覆盖，故无归属。
    expect(displayContainingPoint([primary, secondary], { x: 1440, y: 100 })).toBeUndefined()
  })
})

describe('matchSourcesToDisplays', () => {
  it('pairs sources to displays by stringified display id', () => {
    const plan = matchSourcesToDisplays([source('1'), source('3')], [primary, secondary])
    expect(plan.matches.map((m) => [m.display.id, m.source.displayId])).toEqual([
      [1, '1'],
      [3, '3'],
    ])
    expect(plan.missingDisplays).toEqual([])
  })

  it('reports displays that have no matching source', () => {
    const plan = matchSourcesToDisplays([source('1')], [primary, secondary])
    expect(plan.matches.map((m) => m.display.id)).toEqual([1])
    expect(plan.missingDisplays).toEqual([secondary])
  })

  it('ignores sources that belong to unknown displays', () => {
    const plan = matchSourcesToDisplays([source('1'), source('99')], [primary])
    expect(plan.matches.map((m) => m.display.id)).toEqual([1])
    expect(plan.missingDisplays).toEqual([])
  })

  it('preserves display order in the match list regardless of source order', () => {
    const plan = matchSourcesToDisplays([source('3'), source('1')], [primary, secondary])
    expect(plan.matches.map((m) => m.display.id)).toEqual([1, 3])
  })
})

describe('frameScaleOf', () => {
  it('derive the bitmap-to-DIP ratio from the actual sizes', () => {
    // 2x 屏：位图是 DIP 的两倍，比值即 2，不靠 scaleFactor 推。
    expect(frameScaleOf(primary, { width: 2880, height: 1800 })).toEqual({ width: 2, height: 2 })
  })

  it('stay at 1 when the frame was downscaled into a shared thumbnail bound', () => {
    // thumbnailSize 对所有屏是同一个上界，较小的屏会被缩到与 DIP 同量级，此时比值才是 1。
    expect(frameScaleOf(primary, { width: 1440, height: 900 })).toEqual({ width: 1, height: 1 })
  })

  it('report zero ratios for a degenerate frame size instead of dividing by zero', () => {
    expect(frameScaleOf(primary, { width: 0, height: 0 })).toEqual({ width: 0, height: 0 })
  })

  it('carry the axes independently', () => {
    expect(frameScaleOf(primary, { width: 2880, height: 900 })).toEqual({ width: 2, height: 1 })
  })
})

describe('dipRectToFrameRect', () => {
  const frame = { width: 2880, height: 1800 }

  it('scale a display-relative DIP rect into frame pixels', () => {
    expect(dipRectToFrameRect({ x: 10, y: 20, width: 100, height: 50 }, primary, frame)).toEqual({
      x: 20,
      y: 40,
      width: 200,
      height: 100,
    })
  })

  it('keep the crop at native pixels on a HiDPI display so nothing is written at half resolution', () => {
    const rect = { x: 0, y: 0, width: 200, height: 150 }

    const cropped = dipRectToFrameRect(rect, primary, frame)

    expect(cropped?.width).toBe(rect.width * primary.scaleFactor)
    expect(cropped?.height).toBe(rect.height * primary.scaleFactor)
  })

  it('clip a rect that hangs over the frame edge instead of sampling outside it', () => {
    expect(dipRectToFrameRect({ x: 1400, y: 850, width: 400, height: 200 }, primary, frame)).toEqual({
      x: 2800,
      y: 1700,
      width: 80,
      height: 100,
    })
  })

  it('clip negative origins to the frame', () => {
    expect(dipRectToFrameRect({ x: -10, y: -10, width: 20, height: 20 }, primary, frame)).toEqual({
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    })
  })

  it('return null rather than an empty crop when the rect lies outside the frame', () => {
    expect(dipRectToFrameRect({ x: 2000, y: 0, width: 100, height: 100 }, primary, frame)).toBeNull()
    expect(dipRectToFrameRect({ x: 0, y: 0, width: 100, height: 100 }, primary, { width: 0, height: 0 })).toBeNull()
  })

  it('round to whole pixels so the crop never straddles a pixel boundary', () => {
    const fractional: DisplayLike = {
      id: 7,
      scaleFactor: 2,
      bounds: { x: 0, y: 0, width: 1000, height: 700 },
    }

    expect(dipRectToFrameRect({ x: 1, y: 1, width: 10, height: 10 }, fractional, { width: 1001, height: 701 })).toEqual({
      x: 1,
      y: 1,
      width: 10,
      height: 10,
    })
  })

  it('reject a rect carrying NaN instead of letting it slip through every arithmetic guard', () => {
    // NaN 与任何数的比较都是 false，连「面积非正即拒绝」都拦不住，最后一路交给裁剪 API。
    expect(dipRectToFrameRect({ x: NaN, y: 10, width: 100, height: 50 }, primary, frame)).toBeNull()
    expect(dipRectToFrameRect({ x: 10, y: NaN, width: 100, height: 50 }, primary, frame)).toBeNull()
    expect(dipRectToFrameRect({ x: 10, y: 10, width: NaN, height: 50 }, primary, frame)).toBeNull()
    expect(dipRectToFrameRect({ x: 10, y: 10, width: 100, height: NaN }, primary, frame)).toBeNull()
  })
})
