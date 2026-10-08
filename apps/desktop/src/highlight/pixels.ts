/**
 * 像素缓冲的通道序搬运。
 *
 * Electron 的 `nativeImage.toBitmap()` 给出的原始位图是 BGRA 序（已实测：一张左纯红右纯蓝的
 * 2×1 图往返后，首像素字节为 00 00 FF FF 而非 FF 00 00 FF），而 edge_det 与浏览器的
 * ImageData 都按 RGBA 读。这不是可选的对齐问题——通道互换会同时改变亮度与色相，
 * 边缘检测是基于灰度的，喂错序等于把红蓝分量互换后再判边缘。
 */

/**
 * 把 BGRA 原始位图就地翻成 RGBA。原地改写以避免大屏下再多一份等长缓冲。
 * 循环条件保证四个通道都在界内，`?? 0` 只为满足取值可能为空的类型约束。
 */
export function bgraToRgba(bitmap: Uint8Array): Uint8Array {
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const blue = bitmap[i] ?? 0
    const red = bitmap[i + 2] ?? 0
    bitmap[i] = red
    bitmap[i + 2] = blue
  }
  return bitmap
}
