import { describe, expect, it, vi } from 'vitest'
import { createSelectionCopier, pickCopyTarget, wholeDisplayRect } from '../src/selection/selection'
import type { DisplayLike, Point, Rect, Size } from '../src/freeze/geometry'
import type { FreezeFrame, SelectionSource } from '../src/freeze/controller'

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

function frame(size: Size | null = { width: 1600, height: 1200 }): FreezeFrame {
  return { id: 'src', displayId: '1', size, dataUrl: 'data:image/png;base64,probe' }
}

function source(
  display: DisplayLike,
  locked: Rect | null,
  size: Size | null = { width: 1600, height: 1200 },
): SelectionSource {
  return { display, frame: frame(size), locked }
}

const LOCKED: Rect = { x: 40, y: 30, width: 200, height: 150 }

describe('pickCopyTarget', () => {
  it('没有素材时不选目标', () => {
    expect(pickCopyTarget([])).toBeNull()
  })

  it('有锁定选区时取该选区', () => {
    const target = pickCopyTarget([source(primary, LOCKED)])

    expect(target?.region).toEqual(LOCKED)
    expect(target?.fromLock).toBe(true)
    expect(target?.source.display.id).toBe(1)
  })

  it('没有锁定时退化为该屏整幅', () => {
    const target = pickCopyTarget([source(primary, null)])

    expect(target?.region).toEqual(wholeDisplayRect(primary))
    expect(target?.fromLock).toBe(false)
  })

  it('多屏只有一块有锁定时取那一块，不看光标', () => {
    const pointer: Point = { x: -500, y: 10 }

    const target = pickCopyTarget([source(primary, null), source(secondary, LOCKED)], pointer)

    expect(target?.source.display.id).toBe(2)
  })

  it('多屏同时有锁定时取光标所在的屏', () => {
    const sources = [source(primary, LOCKED), source(secondary, { x: 5, y: 5, width: 50, height: 50 })]

    expect(pickCopyTarget(sources, { x: 100, y: 100 })?.source.display.id).toBe(1)
    expect(pickCopyTarget(sources, { x: -500, y: 10 })?.source.display.id).toBe(2)
  })

  it('光标不在任何含锁的屏上时按素材次序取第一个含锁素材，不因此丢锁', () => {
    const sources = [source(primary, LOCKED), source(secondary, { x: 5, y: 5, width: 50, height: 50 })]

    // 光标落在所有显示器之外：无匹配即回落第一个含锁素材。
    expect(pickCopyTarget(sources, { x: 9000, y: 9000 })?.source.display.id).toBe(1)
    // 光标落在无锁的主屏上：同理不应因为「光标在别处」就丢掉副屏的锁定。
    expect(
      pickCopyTarget([source(primary, null), source(secondary, LOCKED)], { x: 100, y: 100 })?.source.display.id,
    ).toBe(2)
  })

  it('都没锁定且光标在副屏上时取光标所在的屏，与锁定分支同口径', () => {
    const target = pickCopyTarget(
      [source(primary, null), source(secondary, null)],
      { x: -500, y: 10 },
    )

    expect(target?.source.display.id).toBe(2)
    expect(target?.region).toEqual(wholeDisplayRect(secondary))
    expect(target?.fromLock).toBe(false)
  })

  it('都没锁定且光标不在任何一屏上时才按素材次序取第一个', () => {
    const sources = [source(primary, null), source(secondary, null)]

    // 光标落在所有显示器之外（窗口之间的一道缝、或已被移出桌面）：无匹配即回落第一个素材。
    expect(pickCopyTarget(sources, { x: 9000, y: 9000 })?.source.display.id).toBe(1)
    // 连光标信号都没有时同理。
    expect(pickCopyTarget(sources)?.source.display.id).toBe(1)
    expect(pickCopyTarget(sources)?.fromLock).toBe(false)
  })
})

function harness(sources: readonly SelectionSource[], pointer?: Point) {
  const readSources = vi.fn(async () => sources)
  const writeCrop = vi.fn<(frame: FreezeFrame, rect: Rect) => Promise<void>>(async () => {})
  const warn = vi.fn()
  const info = vi.fn()
  const copier = createSelectionCopier({
    readSources,
    writeCrop,
    pointer: pointer === undefined ? undefined : () => pointer,
    logger: { info, warn, error: vi.fn() },
  })
  return { copier, readSources, writeCrop, warn, info }
}

describe('createSelectionCopier', () => {
  it('锁定选区按帧位图比例换算成像素裁剪矩形后交给写盘方', async () => {
    const { copier, writeCrop } = harness([source(primary, LOCKED)])

    // 主屏 DIP 800x600，帧位图 1600x1200：比值 2，锁定矩形等比放大一倍。
    const outcome = await copier()

    expect(outcome).toEqual({
      kind: 'copied',
      displayId: 1,
      fromLock: true,
      pixelRect: { x: 80, y: 60, width: 400, height: 300 },
    })
    expect(writeCrop).toHaveBeenCalledWith(expect.objectContaining({ id: 'src' }), {
      x: 80,
      y: 60,
      width: 400,
      height: 300,
    })
  })

  it('未锁定时裁整幅：像素矩形覆盖整个帧位图', async () => {
    const { copier, writeCrop } = harness([source(primary, null)])

    const outcome = await copier()

    expect(outcome).toEqual({
      kind: 'copied',
      displayId: 1,
      fromLock: false,
      pixelRect: { x: 0, y: 0, width: 1600, height: 1200 },
    })
    expect(writeCrop).toHaveBeenCalledTimes(1)
  })

  it('屏比帧小时按实测比值裁出该屏的那一份，不按 scaleFactor 放大', async () => {
    // 副屏 1000x800 DIP，帧位图只给了 500x400（thumbnailSize 是全屏共用上界时被缩小的一侧）。
    const { copier } = harness([source(secondary, { x: 100, y: 100, width: 200, height: 100 }, { width: 500, height: 400 })])

    const outcome = await copier()

    expect(outcome).toMatchObject({ pixelRect: { x: 50, y: 50, width: 100, height: 50 } })
  })

  it('没有覆盖窗时不写剪贴板', async () => {
    const { copier, writeCrop, warn } = harness([])

    expect(await copier()).toEqual({ kind: 'skipped', reason: 'no-window' })
    expect(writeCrop).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('帧位图尺寸未知时不猜，如实跳过', async () => {
    const { copier, writeCrop, warn } = harness([source(primary, LOCKED, null)])

    expect(await copier()).toEqual({ kind: 'skipped', reason: 'frame-size-unknown' })
    expect(writeCrop).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('选区完全落在帧外时不裁出空图', async () => {
    const { copier, writeCrop } = harness([source(primary, { x: 900, y: 700, width: 100, height: 100 })])

    expect(await copier()).toEqual({ kind: 'skipped', reason: 'no-target' })
    expect(writeCrop).not.toHaveBeenCalled()
  })

  it('多屏同时有锁定时记一行日志说明取了哪一块', async () => {
    const { copier, warn } = harness([
      source(primary, LOCKED),
      source(secondary, { x: 5, y: 5, width: 50, height: 50 }),
    ])

    await copier()

    expect(warn.mock.calls.some(([message]) => String(message).includes('多块'))).toBe(true)
  })

  it('写盘方抛错时把异常交给调用方，不吞成静默成功', async () => {
    const { copier, writeCrop } = harness([source(primary, LOCKED)])
    writeCrop.mockRejectedValueOnce(new Error('剪贴板写入失败'))

    await expect(copier()).rejects.toThrow(/剪贴板写入失败/)
  })
})
