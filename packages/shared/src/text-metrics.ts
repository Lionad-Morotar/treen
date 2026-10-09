/**
 * 文本前进宽度度量：把「一段文本占多宽」从浏览器量算里剥离，让需要几何的纯逻辑
 * （渲染站的 SVG 包围盒、桌面覆盖层的译文折行与字号自适应）可在 Node 下被单测覆盖。
 *
 * 度量绑定等宽字体栈：等宽字体的字符前进宽度是常量，于是 `宽度 = Σ(逐字符 em) × fontSize`
 * 是字体物理属性而非经验拟合。数值取自真机 Chromium（Menlo / SF Mono 栈，font-size 16）实测：
 * 半角约 0.602em、全角（CJK 汉字、假名、全角标点）1em。更换字体栈即须重新标定这三项常量——
 * 这是「字体可控，度量才可控」这条产品约束的代价。
 *
 * 单独成子路径导出（`@treen/shared/text-metrics`）而不并入包根：包根的 env / logger 触碰
 * node:fs / node:util，浏览器侧代码（渲染站页面与客户端 bundle）只能引用本文件这类无 Node 依赖的纯逻辑。
 */

/** 与上述前进宽度绑定的等宽字体栈。改此值必须同步重新标定下方两项常量。 */
export const MONOSPACE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace'

/** 半角字符（拉丁字母、数字、ASCII 标点）的前进宽度（em）。 */
export const HALFWIDTH_ADVANCE_EM = 0.602

/**
 * 全角字符的前进宽度（em）。全角是汉字在等宽上下文里的固有宽度，不随字体栈变化，故取整数 1。
 */
export const FULLWIDTH_ADVANCE_EM = 1

/** 判断码点是否按全角（1em）计宽。覆盖 CJK、假名、谚文与全角标点区段。 */
export function isFullWidthCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

/** 文本在等宽字体下的总前进宽度（em）：逐码点累加半角 / 全角宽度。 */
export function advanceEm(text: string): number {
  let em = 0
  for (const char of text) {
    em += isFullWidthCodePoint(char.codePointAt(0) ?? 0) ? FULLWIDTH_ADVANCE_EM : HALFWIDTH_ADVANCE_EM
  }
  return em
}
