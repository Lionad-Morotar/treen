import { describe, expect, it } from 'vitest'
import {
  MAX_CANDIDATE_EXTENT,
  buildCandidates,
  edgeCandidates,
  intersectRects,
  orderCandidates,
  windowCandidates,
  type BorderRect,
  type Candidate,
  type SystemWindowLike,
} from '../src/highlight/candidates'
import type { DisplayLike } from '../src/freeze/geometry'

// 主屏 1440×900 逻辑点、2 倍缩放（物理 2880×1800）；副屏在主屏左侧、1 倍缩放。
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

function edge(x: number, y: number, w: number, h: number): BorderRect {
  return { x, y, w, h }
}

function candidate(
  x: number,
  y: number,
  width: number,
  height: number,
  source: Candidate['source'] = 'edge',
): Candidate {
  return { x, y, width, height, source }
}

describe('edgeCandidates', () => {
  it('把物理像素边界按显示器与位图的尺寸比换算成显示器相对 DIP', () => {
    const result = edgeCandidates(primary, { width: 2880, height: 1800 }, [edge(100, 50, 200, 100)])

    expect(result).toEqual([candidate(50, 25, 100, 50)])
  })

  it('位图被缩放填进共用上界时用实测比值而非 scaleFactor', () => {
    // 副屏物理 1920×1080，但截屏上界取的是主屏的 2880×1800：位图被放大到 2880×1620。
    // 若按 scaleFactor=1 换算会得到 2880 宽，超出显示器一倍。
    const result = edgeCandidates(secondary, { width: 2880, height: 1620 }, [edge(2880, 1620, 288, 162)])

    expect(result).toEqual([candidate(1920, 1080, 192, 108)])
  })

  it('丢弃退化与非有限数值的边界', () => {
    const result = edgeCandidates(primary, { width: 2880, height: 1800 }, [
      edge(0, 0, 0, 100),
      edge(0, 0, 100, 1),
      { x: Number.NaN, y: 0, w: 100, h: 100 },
      edge(10, 10, 100, 100),
    ])

    expect(result).toEqual([candidate(5, 5, 50, 50)])
  })

  it('丢弃超出合理量级的边界', () => {
    const result = edgeCandidates(primary, { width: 2880, height: 1800 }, [
      edge(0, 0, MAX_CANDIDATE_EXTENT * 4, 100),
    ])

    expect(result).toEqual([])
  })

  it('位图尺寸缺失时不产生任何候选', () => {
    expect(edgeCandidates(primary, { width: 0, height: 0 }, [edge(0, 0, 100, 100)])).toEqual([])
  })
})

describe('windowsCandidates', () => {
  function win(x: number, y: number, width: number, height: number, extra: Partial<SystemWindowLike> = {}): SystemWindowLike {
    return { bounds: { x, y, width, height }, ...extra }
  }

  it('把跨屏窗口裁到本屏并换算成显示器相对坐标', () => {
    const result = windowCandidates(primary, [win(-100, 100, 800, 400)])

    // 与 primary 的交集是 (0,100)-(700,500)，相对原点是 (0,100)-(700,500)。
    expect(result).toEqual([candidate(0, 100, 700, 400, 'window')])
  })

  it('负坐标副屏上的窗口按该屏原点归零', () => {
    const result = windowCandidates(secondary, [win(-1800, 20, 400, 300)])

    expect(result).toEqual([candidate(120, 20, 400, 300, 'window')])
  })

  it('丢弃与本屏无交集的窗口', () => {
    const result = windowCandidates(secondary, [win(0, 0, 400, 300)])

    expect(result).toEqual([])
  })

  it('丢弃系统 UI 层的窗口', () => {
    const result = windowCandidates(primary, [
      win(0, 0, 1440, 900, { bundleId: 'com.apple.loginwindow' }),
      win(0, 0, 1440, 900, { bundleId: 'com.apple.dock' }),
      win(10, 10, 400, 300, { bundleId: 'com.apple.finder' }),
    ])

    expect(result).toEqual([candidate(10, 10, 400, 300, 'window')])
  })

  it('丢弃窗口枚举器的哨兵矩形（裁剪前拦住，否则裁完就是整块屏）', () => {
    const result = windowCandidates(primary, [win(-15000, -15000, 30000, 30000)])

    expect(result).toEqual([])
  })

  it('剔除本应用自己的窗口', () => {
    const result = windowCandidates(
      primary,
      [win(0, 0, 1440, 900, { processId: 4242 }), win(10, 10, 400, 300, { processId: 99 })],
      { excludeProcessId: 4242 },
    )

    expect(result).toEqual([candidate(10, 10, 400, 300, 'window')])
  })

  it('裁剪后小于最小边长的窗口不计入候选', () => {
    const result = windowCandidates(primary, [win(1439, 100, 500, 400)])

    expect(result).toEqual([])
  })
})

describe('intersectRects', () => {
  it('返回交集的几何', () => {
    expect(
      intersectRects({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }),
    ).toEqual({ x: 50, y: 50, width: 50, height: 50 })
  })

  it('无交集时宽高为 0', () => {
    expect(
      intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 }),
    ).toEqual({ x: 20, y: 20, width: 0, height: 0 })
  })
})

describe('orderCandidates', () => {
  it('按面积降序排列，小矩形在后（层叠在上）', () => {
    const result = orderCandidates([
      candidate(0, 0, 100, 100),
      candidate(0, 0, 10, 10),
      candidate(0, 0, 50, 50),
    ])

    expect(result.map((c) => c.width)).toEqual([100, 50, 10])
  })

  it('面积相同时按左上角坐标兜底排序，保证输出稳定', () => {
    const result = orderCandidates([
      candidate(30, 30, 10, 10),
      candidate(10, 10, 10, 10),
      candidate(10, 5, 10, 10),
    ])

    expect(result.map((c) => [c.x, c.y])).toEqual([
      [10, 5],
      [10, 10],
      [30, 30],
    ])
  })

  it('不修改入参数组', () => {
    const input = [candidate(0, 0, 100, 100), candidate(0, 0, 10, 10)]
    orderCandidates(input)

    expect(input.map((c) => c.width)).toEqual([100, 10])
  })
})

describe('buildCandidates', () => {
  it('合成两路并排出层叠次序', () => {
    const result = buildCandidates({
      display: primary,
      frameSize: { width: 2880, height: 1800 },
      borders: [edge(100, 100, 1000, 1000)],
      windows: [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
    })

    expect(result.map((c) => [c.source, c.width, c.height])).toEqual([
      ['window', 1440, 900],
      ['edge', 500, 500],
    ])
  })

  it('只给边缘时不产出窗口候选', () => {
    const result = buildCandidates({
      display: primary,
      frameSize: { width: 2880, height: 1800 },
      borders: [edge(0, 0, 100, 100)],
    })

    expect(result.map((c) => c.source)).toEqual(['edge'])
  })

  it('只给窗口时不产出边缘候选', () => {
    const result = buildCandidates({
      display: primary,
      windows: [{ bounds: { x: 0, y: 0, width: 200, height: 200 } }],
    })

    expect(result.map((c) => c.source)).toEqual(['window'])
  })

  it('两路都不给时无候选', () => {
    expect(buildCandidates({ display: primary })).toEqual([])
  })
})
