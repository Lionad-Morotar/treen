import { describe, expect, it } from 'vitest'
import {
  bytesOfDataUrl,
  formatBytes,
  formatDuration,
  imagePayloadWarning,
  isImageFile,
  MAX_IMAGE_BYTES,
  pairTranslations,
  themeCssVariables,
  toEditableBlocks,
} from '../app/utils/dev-pipeline-format'

describe('尺寸与耗时展示', () => {
  it('字节数按 1024 进制换挡，保留一位小数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('亚秒用毫秒、过秒用秒，避免 OCR 的 2000ms 被写成 2s 丢精度', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(950)).toBe('950 ms')
    expect(formatDuration(1234)).toBe('1.23 s')
  })
})

describe('图像载荷', () => {
  it('从 data URL 反算字节数：base64 每 4 字符 3 字节，等号各减一', () => {
    expect(bytesOfDataUrl('data:image/png;base64,AAAA')).toBe(3)
    expect(bytesOfDataUrl('data:image/png;base64,AA==')).toBe(1)
    expect(bytesOfDataUrl('data:image/png;base64,')).toBe(0)
  })

  it('认不出形态时给 0，交由调用方决定是否提示', () => {
    expect(bytesOfDataUrl('not-a-data-url')).toBe(0)
  })

  it('超过上限的图给出提示文案，小图不打扰', () => {
    expect(imagePayloadWarning(1024)).toBeNull()
    expect(imagePayloadWarning(MAX_IMAGE_BYTES)).toBeNull()
    const warning = imagePayloadWarning(MAX_IMAGE_BYTES + 1)
    expect(warning).toContain('8.0 MB')
  })

  it('收图只认 PNG/JPEG：空 type 时退回扩展名，二者都不符就拒', () => {
    expect(isImageFile({ name: 'shot.png', type: 'image/png' })).toBe(true)
    expect(isImageFile({ name: 'shot.jpg', type: '' })).toBe(true)
    expect(isImageFile({ name: 'shot.jpeg', type: '' })).toBe(true)
    expect(isImageFile({ name: 'notes.txt', type: 'text/plain' })).toBe(false)
    expect(isImageFile({ name: 'page.webp', type: 'image/webp' })).toBe(false)
  })
})

describe('OCR 结果的可编辑副本', () => {
  it('编辑副本不改动原始识别结果，改完才能作为下一步输入', () => {
    const source = [{ text: 'Hello', confidence: 0.9, box: { x: 0, y: 0, width: 10, height: 4 } }]

    const editable = toEditableBlocks(source)
    editable[0]!.text = 'Hello!'

    expect(source[0]!.text).toBe('Hello')
    expect(editable[0]!.text).toBe('Hello!')
  })
})

describe('译文并列', () => {
  it('按索引把原文、译文与门控标记对成一行', () => {
    expect(pairTranslations(['hello', '世界'], ['你好', '世界'], [false, true])).toEqual([
      { source: 'hello', translation: '你好', gated: false },
      { source: '世界', translation: '世界', gated: true },
    ])
  })

  /**
   * 长度由服务端契约保证，但越界访问会把整个面板打崩；补齐值取「空译文 + 未标门控」
   * 是为了不把「不知道」渲染成「确实已送译」。
   */
  it('服务端少给译文时补齐而不是越界', () => {
    expect(pairTranslations(['a', 'b'], [], [])).toEqual([
      { source: 'a', translation: '', gated: false },
      { source: 'b', translation: '', gated: false },
    ])
  })
})

describe('主题色桥接', () => {
  /**
   * 页面不许再抄一份字面色值，故把 mermaid 主题变量翻成 CSS 变量再给 scoped 样式用。
   * 输入用字面量写出，不取 MERMAID_THEME_VARIABLES 自查。
   */
  it('把主题变量翻成 --treen-* 的 CSS 变量，键转连字符', () => {
    expect(
      themeCssVariables({ primaryTextColor: '#cde7ff', fontSize: '16px', background: '#0a0e14' }),
    ).toEqual({
      '--treen-primary-text-color': '#cde7ff',
      '--treen-font-size': '16px',
      '--treen-background': '#0a0e14',
    })
  })

  it('布尔键不进 CSS 变量：没有对应的 CSS 语义，留着只会误导', () => {
    expect(themeCssVariables({ darkMode: true, background: '#0a0e14' })).toEqual({
      '--treen-background': '#0a0e14',
    })
  })
})
