import type { FreezeFrame } from './controller'
import type { Size } from './geometry'

/**
 * 抓屏与帧投影（纯逻辑）。
 *
 * 从抓屏源的枚举结果里挑出可用的屏位图并投影成 FreezeFrame。枚举方式作为参数注入：
 * 真实链路传 desktopCapturer，回放/测试传「读一张固定 PNG 的假实现」——于是「读图 → 包成帧」
 * 这条路径能在无 Electron 的 Node 下被端到端验收，而不必起真 GUI。
 *
 * 与 electron-adapters 分家是刻意的（与该域其它纯逻辑模块同因）：adapters 在 import 期即触碰
 * electron 运行时，纯 Node 测试导入它会连带加载 Electron 而失败；这里不 import electron，
 * 故可以进冻结域的桶文件、被回放测试直接引用。
 */

/**
 * 抓屏源在投影面需要的最小形态：身份 + 缩略图的尺寸与 data URL。
 *
 * 与 Electron 的 DesktopCapturerSource 结构相容（thumbnail 的 getSize/toDataURL 是 NativeImage
 * 的成员），故真实源可原样喂入，无需一层适配。
 */
export interface CaptureScreenSource {
  id: string
  /** desktopCapturer 的 display_id（字符串）；镜像/聚合源为空串 */
  display_id: string
  thumbnail: {
    getSize(): Size
    toDataURL(): string
  }
}

/** 抓屏源枚举器：吃几何层规划好的缩略图尺寸，吐出各屏的源。真实实现走 desktopCapturer。 */
export type ScreenGrabber = (thumbnailSize: Size) => Promise<readonly CaptureScreenSource[]>

/**
 * 逐屏抓取静态位图并投影成帧。thumbnailSize 由几何层按物理像素规划后传入。
 *
 * display_id 为空串的是镜像/聚合源，定位不到具体屏，直接丢弃；缩略图尺寸取零的源把 size 留 null，
 * 由下游按「尺寸未知」处置而不是猜一个比例。
 *
 * 枚举失败包一层带因的错再抛：截屏失败最常见的原因是未授予屏幕录制权限，把原因吞掉会让用户
 * 看到「按了没反应」却查不出所以然。
 */
export async function captureFrames(
  thumbnailSize: Size,
  grab: ScreenGrabber,
): Promise<FreezeFrame[]> {
  let sources: readonly CaptureScreenSource[]
  try {
    sources = await grab(thumbnailSize)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`截屏失败：无法枚举屏幕源（${reason}）`, { cause: error })
  }
  return sources
    .filter((source) => source.display_id !== '')
    .map((source) => {
      const size = source.thumbnail.getSize()
      return {
        id: source.id,
        displayId: source.display_id,
        size: size.width > 0 && size.height > 0 ? size : null,
        dataUrl: source.thumbnail.toDataURL(),
      }
    })
}
