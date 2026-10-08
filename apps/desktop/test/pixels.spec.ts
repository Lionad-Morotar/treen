import { describe, expect, it } from 'vitest'
import { bgraToRgba } from '../src/highlight/pixels'

describe('bgraToRgba', () => {
  it('交换红蓝分量，绿色与透明度原位不动', () => {
    // 左像素 BGRA=(0,0,255,255) 即纯红，右像素 BGRA=(255,0,0,255) 即纯蓝。
    const bitmap = new Uint8Array([0, 0, 255, 255, 255, 0, 0, 255])

    expect([...bgraToRgba(bitmap)]).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  })

  it('原地改写并返回同一份缓冲', () => {
    const bitmap = new Uint8Array([1, 2, 3, 4])

    expect(bgraToRgba(bitmap)).toBe(bitmap)
  })

  it('容忍末尾不足一个像素的残余字节', () => {
    const bitmap = new Uint8Array([0, 0, 255, 255, 9, 9])

    expect([...bgraToRgba(bitmap)]).toEqual([255, 0, 0, 255, 9, 9])
  })
})
