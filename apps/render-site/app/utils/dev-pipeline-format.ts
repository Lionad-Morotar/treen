import type { OcrBlockPayload } from './dev-pipeline-client'

/**
 * 调试页的展示层纯函数：格式化、越界兜底、以及把主题常量桥成 CSS 变量。
 *
 * 全部不碰 DOM、不 import Vue，既能在单测里直接装载，也让页面上那些「一眼看不出对错」的
 * 换算（base64 反算字节、耗时换挡、主题键转连字符）有地方被单独验证。
 */

/**
 * 送服务端前的告警门槛。
 *
 * 取 8 MB 而非更大：截图转 data URL 会膨胀约三分之一，再经一次 POST，服务端读整个 body
 * 进内存——门槛定在「明显已经不是常规截图」的量级上，早提示比转完才卡住强。
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const

export interface EditableBlock {
  text: string
  confidence: number
  box: { x: number; y: number; width: number; height: number }
}

export interface TranslationPair {
  source: string
  translation: string
  /** 为真表示这条被「已是目标语言」门控跳过，原文回填、未真正送译 */
  gated: boolean
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 亚秒走毫秒、过秒走秒：OCR 的两秒级耗时不该被抹成整数秒。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`
  }
  return `${(ms / 1000).toFixed(2)} s`
}

/**
 * 从 data URL 反算原始字节数。
 *
 * 只数载荷部分：前缀（mime、base64 标记）与等号填充都不是图像字节，算进去会让告警门槛
 * 提前约三分之一。
 */
export function bytesOfDataUrl(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) {
    return 0
  }
  const payload = dataUrl.slice(comma + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding)
}

/** 超过门槛的图给出提示文案（含门槛值，便于判断该先压图还是照跑）；否则 null。 */
export function imagePayloadWarning(bytes: number): string | null {
  if (bytes <= MAX_IMAGE_BYTES) {
    return null
  }
  return `这张图有 ${formatBytes(bytes)}，超过 ${formatBytes(MAX_IMAGE_BYTES)}：转 data URL 与上传都会明显变慢，OCR 也可能更久。`
}

/**
 * 收图只认 PNG/JPEG。
 *
 * 先看 type 再看扩展名：拖拽与粘贴有时拿不到 type（尤其是从某些应用里拖出来的位图），
 * 此时扩展名是唯一线索；反过来 type 不可信时扩展名也不该被无条件放行，故两者都不符才拒。
 */
export function isImageFile(file: { name: string; type: string }): boolean {
  if (file.type === 'image/png' || file.type === 'image/jpeg') {
    return true
  }
  const lower = file.name.toLowerCase()
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * OCR 结果的可编辑副本。
 *
 * 连 box 一起浅拷：列表要在页面上被改写，而改写的是「下一步的输入」，不该顺手改掉上一次
 * 识别留存的原始结果——没有副本就无法回答「改之前识别到的是什么」。
 */
export function toEditableBlocks(blocks: readonly OcrBlockPayload[]): EditableBlock[] {
  return blocks.map((block) => ({
    text: block.text,
    confidence: block.confidence,
    box: { ...block.box },
  }))
}

/**
 * 按索引把原文、译文与门控标记对成一行。
 *
 * 三份数组由服务端契约保证等长；仍逐项兜底是因为越界访问会把整个面板打崩，而补齐值取
 * 「空译文 + 未标门控」——不把「不知道」渲染成「确实已送译」。
 */
export function pairTranslations(
  sources: readonly string[],
  translations: readonly string[],
  gated: readonly boolean[],
): TranslationPair[] {
  return sources.map((source, index) => ({
    source,
    translation: translations[index] ?? '',
    gated: gated[index] ?? false,
  }))
}

function kebabOf(key: string): string {
  return key.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)
}

/**
 * 把 mermaid 主题变量桥成 `--treen-*` 的 CSS 变量。
 *
 * 页面不许再抄一份字面色值，而 `MERMAID_THEME_VARIABLES` 是 TS 常量、织不进 scoped 样式，
 * 故在页面根上以行内 style 注入一次，子树里的 `var(--treen-*)` 随 DOM 继承下去。选注入而非
 * 生成样式表：变量随主题常量走同一条引用链，改配色只改主题那一处。
 *
 * 布尔值不进变量：CSS 侧没有对应的语义，留着只会让人以为存在 `--treen-dark-mode` 可切换。
 */
export function themeCssVariables(
  theme: Readonly<Record<string, string | number | boolean>>,
): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value === 'boolean') {
      continue
    }
    variables[`--treen-${kebabOf(key)}`] = String(value)
  }
  return variables
}
