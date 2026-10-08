import { describe, expect, it } from 'vitest'
import {
  captureThumbnailSize,
  displayContainingPoint,
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
