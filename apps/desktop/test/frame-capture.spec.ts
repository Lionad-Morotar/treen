import { describe, expect, it, vi } from 'vitest'
import { captureFrames, type CaptureScreenSource, type ScreenGrabber } from '../src/freeze/frame-capture'
import type { Size } from '../src/freeze/geometry'

/**
 * 帧投影的纯逻辑：抓屏源 → FreezeFrame。真实枚举（desktopCapturer）被替换成注入的假实现，
 * 于是「读一张 PNG 并包成帧」这条链在无 Electron 的 Node 下即可验收。
 */

function source(overrides: Partial<CaptureScreenSource> & { size?: Size; dataUrl?: string }): CaptureScreenSource {
  const size = overrides.size ?? { width: 400, height: 300 }
  return {
    id: overrides.id ?? 'src-1',
    display_id: overrides.display_id ?? '1',
    thumbnail: {
      getSize: () => size,
      toDataURL: () => overrides.dataUrl ?? 'data:image/png;base64,AAAA',
    },
  }
}

const THUMB: Size = { width: 800, height: 600 }

describe('captureFrames', () => {
  it('把每个抓屏源投影成带真实尺寸与 data URL 的帧', async () => {
    const grab: ScreenGrabber = async () => [
      source({ id: 'a', display_id: '1', size: { width: 800, height: 600 }, dataUrl: 'data:image/png;base64,Zm9v' }),
    ]

    const frames = await captureFrames(THUMB, grab)

    expect(frames).toEqual([
      { id: 'a', displayId: '1', size: { width: 800, height: 600 }, dataUrl: 'data:image/png;base64,Zm9v' },
    ])
  })

  it('把规划好的缩略图尺寸原样交给抓屏器', async () => {
    const grab = vi.fn<ScreenGrabber>(async () => [])

    await captureFrames(THUMB, grab)

    expect(grab).toHaveBeenCalledWith(THUMB)
  })

  it('丢弃 display_id 为空串的镜像/聚合源', async () => {
    const grab: ScreenGrabber = async () => [
      source({ id: 'mirror', display_id: '' }),
      source({ id: 'real', display_id: '2' }),
    ]

    const frames = await captureFrames(THUMB, grab)

    expect(frames.map((frame) => frame.id)).toEqual(['real'])
  })

  it('缩略图尺寸为零的源把 size 留 null，而不是报一个假尺寸', async () => {
    const grab: ScreenGrabber = async () => [source({ size: { width: 0, height: 0 } })]

    const frames = await captureFrames(THUMB, grab)

    expect(frames[0]?.size).toBeNull()
  })

  it('枚举失败包一层带因的错，指向上游原因而不是笼统的截屏失败', async () => {
    const grab: ScreenGrabber = async () => {
      throw new Error('未授予屏幕录制权限')
    }

    await expect(captureFrames(THUMB, grab)).rejects.toThrow(/未授予屏幕录制权限/)
    await expect(captureFrames(THUMB, grab)).rejects.toThrow(/无法枚举屏幕源/)
  })

  it('没有任何源时返回空数组（交给控制器按「取不到截屏」处置）', async () => {
    expect(await captureFrames(THUMB, async () => [])).toEqual([])
  })
})
