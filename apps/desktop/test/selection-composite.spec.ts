import { describe, expect, it, vi } from 'vitest'
import { createCompositeCopier } from '../src/selection/composite'
import { wholeDisplayRect } from '../src/selection/selection'
import type { DisplayLike, Point, Rect } from '../src/freeze/geometry'
import type { SelectionSource } from '../src/freeze/controller'

/**
 * 合成拷贝的纯逻辑：挑哪块、抓不到像素时怎么办、抓到的字节有没有真的交出去。
 * 与原始截图拷贝共用挑选规则，故这里只钉「合成特有的那几步」，挑选规则本身在 selection.spec 里。
 */

const primary: DisplayLike = {
  id: 1,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 800, height: 600 },
}
const secondary: DisplayLike = {
  id: 2,
  scaleFactor: 1,
  bounds: { x: -1000, y: 0, width: 1000, height: 800 },
}

const LOCKED: Rect = { x: 40, y: 30, width: 200, height: 150 }
const PNG = new Uint8Array([137, 80, 78, 71])

function source(display: DisplayLike, locked: Rect | null): SelectionSource {
  return {
    display,
    frame: { id: 'src', displayId: String(display.id), size: { width: 10, height: 10 }, dataUrl: 'data:,' },
    locked,
  }
}

function harness(options: {
  sources?: readonly SelectionSource[]
  png?: Uint8Array | null
  pointer?: Point
} = {}) {
  const sources = options.sources ?? [source(primary, LOCKED)]
  const capture = vi.fn(async () => (options.png === undefined ? PNG : options.png))
  const writePng = vi.fn(async () => {})
  const warn = vi.fn()
  const info = vi.fn()
  const copier = createCompositeCopier({
    readSources: async () => sources,
    capture,
    writePng,
    pointer: options.pointer === undefined ? undefined : () => options.pointer as Point,
    logger: { warn, info, error: vi.fn() },
  })
  return { copier, capture, writePng, warn, info }
}

describe('createCompositeCopier', () => {
  it('有锁定时抓锁定选区，矩形按显示器相对 DIP 原样交给抓取方', async () => {
    const { copier, capture, writePng } = harness()

    const outcome = await copier.trigger()

    expect(outcome).toEqual({ kind: 'copied', displayId: 1, fromLock: true, region: LOCKED })
    // 抓的是渲染结果，尺度就是 DIP，不做帧位图那套换算。
    expect(capture).toHaveBeenCalledWith(expect.objectContaining({ display: primary }), LOCKED)
    expect(writePng).toHaveBeenCalledWith(PNG)
  })

  it('没有锁定时退化为整屏，且抓的是整屏那一块', async () => {
    const { copier, capture } = harness({ sources: [source(primary, null)] })

    const outcome = await copier.trigger()

    expect(outcome).toMatchObject({ kind: 'copied', fromLock: false })
    expect(capture).toHaveBeenCalledWith(expect.anything(), wholeDisplayRect(primary))
  })

  it('多屏同时有锁定时按光标定屏', async () => {
    const { copier, capture } = harness({
      sources: [source(primary, LOCKED), source(secondary, { x: 5, y: 5, width: 50, height: 50 })],
      pointer: { x: -500, y: 10 },
    })

    const outcome = await copier.trigger()

    expect(outcome).toMatchObject({ kind: 'copied', displayId: 2 })
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({ display: secondary }),
      { x: 5, y: 5, width: 50, height: 50 },
    )
  })

  it('没有覆盖窗时跳过，不抓也不写', async () => {
    const { copier, capture, writePng, warn } = harness({ sources: [] })

    expect(await copier.trigger()).toEqual({ kind: 'skipped', reason: 'no-window' })
    expect(capture).not.toHaveBeenCalled()
    expect(writePng).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('没有可用的覆盖窗'))
  })

  it('抓不到像素时跳过：宁可什么都不写，也不往剪贴板塞一张空图', async () => {
    const { copier, writePng, warn } = harness({ png: null })

    expect(await copier.trigger()).toEqual({ kind: 'skipped', reason: 'no-capture' })
    expect(writePng).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('抓不到渲染结果'))
  })

  it('空选区不发起抓取', async () => {
    const { copier, capture } = harness({ sources: [source(primary, { x: 0, y: 0, width: 0, height: 0 })] })

    expect(await copier.trigger()).toEqual({ kind: 'skipped', reason: 'no-target' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('写剪贴板失败向上抛，由调用方决定呈现', async () => {
    const { copier, writePng } = harness()
    writePng.mockRejectedValueOnce(new Error('剪贴板不可写'))

    await expect(copier.trigger()).rejects.toThrow('剪贴板不可写')
  })
})

describe('createCompositeCopier：连按两次的代次闸门', () => {
  /** 抓取挂起点前还有读素材的微任务，两轮 trigger 后要等它们走到 capture 才能放行。 */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve))
  }

  it('第一轮的抓取在第二轮已发起后才回来，第一轮不落地', async () => {
    const pending: Array<(png: Uint8Array | null) => void> = []
    const writePng = vi.fn(async () => {})
    const copier = createCompositeCopier({
      readSources: async () => [source(primary, LOCKED)],
      capture: () => new Promise((resolve) => pending.push(resolve)),
      writePng,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    // 第二轮要发起于第一轮抓取在途期间（真实连按的形态），两轮才真正并发。
    const first = copier.trigger()
    await settle()
    expect(pending).toHaveLength(1)

    const second = copier.trigger()
    await settle()
    expect(pending).toHaveLength(2)

    // 第二轮先拿到像素并落地；第一轮后到即被丢弃，合成画面只有一份写进剪贴板。
    pending[1]?.(PNG)
    expect(await second).toEqual({ kind: 'copied', displayId: 1, fromLock: true, region: LOCKED })

    pending[0]?.(PNG)
    expect(await first).toEqual({ kind: 'skipped', reason: 'superseded' })
    expect(writePng).toHaveBeenCalledTimes(1)
  })

  it('过期轮抓取落空时报 superseded 而非 no-capture，当前轮落空仍报 no-capture', async () => {
    const firstCaptureGates: Array<(png: Uint8Array | null) => void> = []
    const capture = vi.fn<() => Promise<Uint8Array | null>>()
    capture.mockImplementationOnce(
      () =>
        new Promise<Uint8Array | null>((resolve) => {
          firstCaptureGates.push(resolve)
        }),
    )
    capture.mockResolvedValueOnce(null)
    const writePng = vi.fn(async () => {})
    const copier = createCompositeCopier({
      readSources: async () => [source(primary, LOCKED)],
      capture,
      writePng,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    const first = copier.trigger()
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1))

    // 第二轮自身抓取落空：它仍是最新一轮，如实报 no-capture。
    const second = copier.trigger()
    expect(await second).toEqual({ kind: 'skipped', reason: 'no-capture' })

    // 第一轮此刻已被取代，即便它的抓取也落空，语义是「被取代」而不是「没有渲染结果」。
    firstCaptureGates[0]?.(null)
    expect(await first).toEqual({ kind: 'skipped', reason: 'superseded' })
    expect(writePng).not.toHaveBeenCalled()
  })

  it('invalidate 作废在途轮：退出冻结后抓到的像素也不写', async () => {
    const writePng = vi.fn(async () => {})
    const copier = createCompositeCopier({
      readSources: async () => [source(primary, LOCKED)],
      capture: async () => PNG,
      writePng,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    const first = copier.trigger()
    copier.invalidate()

    expect(await first).toEqual({ kind: 'skipped', reason: 'superseded' })
    expect(writePng).not.toHaveBeenCalled()
  })

  it('写盘经串行闸排队且出队时判代次：被取代的轮轮到写时直接跳过', async () => {
    const firstWriteGates: Array<() => void> = []
    const writePng = vi.fn<() => Promise<void>>()
    writePng.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          firstWriteGates.push(resolve)
        }),
    )
    writePng.mockResolvedValueOnce(undefined)
    const copier = createCompositeCopier({
      readSources: async () => [source(primary, LOCKED)],
      capture: async () => PNG,
      writePng,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })

    const first = copier.trigger()
    await vi.waitFor(() => expect(writePng).toHaveBeenCalledTimes(1))

    // 第二轮全程即时完成素材与抓取，写盘排在第一轮之后；invalidate 后它出队即跳过。
    const second = copier.trigger()
    await settle()
    copier.invalidate()

    firstWriteGates[0]?.()
    expect(await first).toMatchObject({ kind: 'copied' })
    expect(await second).toEqual({ kind: 'skipped', reason: 'superseded' })
    expect(writePng).toHaveBeenCalledTimes(1)
  })
})
