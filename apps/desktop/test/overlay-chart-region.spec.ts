import { describe, expect, it } from 'vitest'
import { chartRegion, rectOfMembers, type PlacedObservation } from '../src/overlay/chart-region'

/**
 * 一块图（声明 + 两行）与三块干扰：同高不同栏的其它文本、下方远处的状态栏、选区外的溢出文字。
 * 坐标是显示器相对 DIP，形似 zRefs/image.png 的多栏布局。
 */
function scene(): PlacedObservation[] {
  return [
    { text: 'graph LR', box: { x: 100, y: 100, width: 80, height: 20 } },
    { text: 'WAV --> A', box: { x: 100, y: 125, width: 140, height: 20 } },
    { text: 'A --> C', box: { x: 100, y: 150, width: 140, height: 20 } },
    // 与声明同一视觉行的左侧文件树：x 与图不重叠，不该被并入。
    { text: 'src/index.ts', box: { x: 0, y: 100, width: 80, height: 20 } },
    // 下方远处的状态栏：垂直间距远超一个行高，不该被并入。
    { text: 'Ln 12, Col 3', box: { x: 100, y: 400, width: 200, height: 20 } },
  ]
}

const BOUND = { x: 50, y: 50, width: 400, height: 300 }

describe('chartRegion：用几何连续性求图的屏幕矩形', () => {
  it('从声明出发并入上下相连的行，产出并集矩形', () => {
    const region = chartRegion(scene(), 0, { bound: BOUND })

    expect(region).toEqual({ x: 100, y: 100, width: 140, height: 70 })
  })

  it('同高不同栏的文本因水平不重叠而不并入', () => {
    const region = chartRegion(scene(), 0, { bound: BOUND })

    // 若误并入左侧文件树，x 会扩到 0。
    expect(region?.x).toBe(100)
  })

  it('垂直间距超过一个行高的相邻块不并入', () => {
    const region = chartRegion(scene(), 0, { bound: BOUND })

    // 若误并入状态栏，y+height 会盖到 420。
    expect((region?.y ?? 0) + (region?.height ?? 0)).toBe(170)
  })

  it('以选区为上界：中心落在选区外的观察被排除', () => {
    // 状态栏在 y=400，选区只到 350，即便间距足够近也不该进来。
    const observations: PlacedObservation[] = [
      { text: 'graph LR', box: { x: 100, y: 100, width: 80, height: 20 } },
      { text: '选区外', box: { x: 100, y: 360, width: 100, height: 20 } },
    ]

    const region = chartRegion(observations, 0, { bound: { x: 50, y: 50, width: 300, height: 300 } })

    expect(region).toEqual({ x: 100, y: 100, width: 80, height: 20 })
  })

  it('gapFactor 调大即把更远的块也并进来', () => {
    const observations: PlacedObservation[] = [
      { text: 'graph LR', box: { x: 0, y: 0, width: 100, height: 20 } },
      { text: '隔了一行', box: { x: 0, y: 60, width: 100, height: 20 } },
    ]

    expect(chartRegion(observations, 0)).toEqual({ x: 0, y: 0, width: 100, height: 20 })
    expect(chartRegion(observations, 0, { gapFactor: 4 })).toEqual({ x: 0, y: 0, width: 100, height: 80 })
  })

  it('不给上界时按几何独立判定：远邻与异栏仍被挡在外面', () => {
    const region = chartRegion(scene(), 0)
    // 三行图源码的并集，状态栏（y=400）与左栏文件树都不该进来。
    expect(region).toEqual({ x: 100, y: 100, width: 140, height: 70 })
  })

  it('锚点下标越界或锚点盒退化时返回 null', () => {
    expect(chartRegion(scene(), 99, { bound: BOUND })).toBeNull()
    expect(
      chartRegion([{ text: 'graph LR', box: { x: 0, y: 0, width: 0, height: 0 } }], 0),
    ).toBeNull()
  })

  it('声明行之上的相邻行不并入——图的源码从声明行往下算', () => {
    const observations: PlacedObservation[] = [
      // 标题与声明之间只隔 4px（远小于行高阈值），但方向不对：并进来会把矩形往上撑到标题。
      { text: '## 三级标题', box: { x: 100, y: 76, width: 120, height: 20 } },
      { text: 'graph LR', box: { x: 100, y: 100, width: 80, height: 20 } },
      { text: 'A --> B', box: { x: 100, y: 125, width: 140, height: 20 } },
    ]

    expect(chartRegion(observations, 1)).toEqual({ x: 100, y: 100, width: 140, height: 45 })
  })

  it('rectOfMembers 按下标子集算并集，空集为 null', () => {
    const observations = scene()

    expect(rectOfMembers(observations, [1, 2])).toEqual({ x: 100, y: 125, width: 140, height: 45 })
    expect(rectOfMembers(observations, [])).toBeNull()
  })

  it('锚点落在选区外时返回 null，不拿选区矩形兜底', () => {
    const observations: PlacedObservation[] = [
      { text: 'graph LR', box: { x: 0, y: 0, width: 80, height: 20 } },
    ]
    expect(chartRegion(observations, 0, { bound: { x: 500, y: 500, width: 100, height: 100 } })).toBeNull()
  })
})
