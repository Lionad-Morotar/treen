/**
 * 渲染站的 mermaid 预置样式与安全配置——服务端渲染器与浏览器渲染页共用的唯一来源。
 *
 * 样式由工具完全控制、用户不可改，是本产品的硬约束（用户不需要会写 mermaid 主题，也无法让截图里的
 * `%%{init}%%` 指令改写 Treen 的视觉）。落实这条约束靠三层，缺一不可：
 *
 * 1. `theme: 'base'` + 写死的 `themeVariables`：视觉的实际来源；
 * 2. `securityLevel: 'strict'` + `secure` 白名单：mermaid 自身对指令覆写的防线；
 * 3. 归一化阶段的 `%%{init}%%` 剥离（见 `stripMermaidInitDirectives`）：真正的锁——实测 `secure`
 *    白名单并拦不住 `themeVariables` 注入，外部内容仍能改配色，必须自己剥。
 *
 * 配色为科技向深色（tech-flavored）：冷色低饱和底、青色描边、等宽字体。改配色只改本文件，
 * 渲染器与页面都从这里取，禁止各处硬编码色值。
 */

/** mermaid 安全级别：禁掉外部内容触发的脚本与链接。 */
export const MERMAID_SECURITY_LEVEL = 'strict' as const

/** 主题基线：`base` 是唯一允许细粒度覆写 themeVariables 的内置主题。 */
export const MERMAID_THEME = 'base' as const

/** 等宽字体栈：科技向的排版语言；同时是「图表不随外部应用的字体漂移」的一部分。 */
export const MERMAID_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace'

/**
 * 允许被源码指令覆写的配置键白名单。
 *
 * 注意这只是纵深防御的一层：实测它的作用域是渲染期配置合并，**拦不住** `themeVariables` 这类键，
 * 故不能替代 init 剥离。列在这里是为收窄其余可覆写面，不作为唯一锁。
 */
export const MERMAID_SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize'] as const

/** 科技向深色配色：冷底 + 青色描边 + 亮色文字，低饱和以免观感脏。 */
export const MERMAID_THEME_VARIABLES = {
  darkMode: true,
  background: '#0a0e14',
  primaryColor: '#0f1b26',
  primaryTextColor: '#cde7ff',
  primaryBorderColor: '#22b8e6',
  secondaryColor: '#101d29',
  secondaryTextColor: '#b9d4ea',
  secondaryBorderColor: '#1f4b63',
  tertiaryColor: '#0c1620',
  tertiaryTextColor: '#9fc0d8',
  tertiaryBorderColor: '#1a3a4d',
  lineColor: '#3fb6e8',
  textColor: '#cde7ff',
  mainBkg: '#0f1b26',
  nodeBorder: '#22b8e6',
  nodeTextColor: '#cde7ff',
  clusterBkg: '#0c1620',
  clusterBorder: '#1f4b63',
  titleColor: '#e6f3ff',
  edgeLabelBackground: '#0a0e14',
  fontFamily: MERMAID_FONT_FAMILY,
  fontSize: '16px',
} as const

/**
 * 额外的科技向微调（细描边、字距），随 themeCSS 注入。
 * 保持极简：只做主题变量表达不了的笔画层细节，任何可能被 mermaid 的 CSS 编译器拒绝的写法都不进这里。
 */
export const MERMAID_THEME_CSS = `
  .node rect, .node circle, .node polygon, .node ellipse, .node path { stroke-width: 1.1px; }
  .cluster rect { stroke-dasharray: 4 3; }
  .nodeLabel, .edgeLabel, .cluster-label, .label { letter-spacing: 0.01em; }
`

/**
 * 各图类型的固有尺寸开关：一律关掉 `useMaxWidth`，让 SVG 输出内容固有像素尺寸。
 * 下游覆盖层要按真实 `viewBox` 做 contain 适配，宽度被 max-width 撑成流式会让适配拿到错值。
 * 未列出的图类型保持 mermaid 默认；新支持的图类型应在此显式关闭。
 *
 * 逐类型写开而非用 `Object.fromEntries` 生成：后者会让 TS 丢失键名，消费方（与测试）无法索引。
 */
const INTRINSIC_SIZE_OFF = { useMaxWidth: false } as const

/**
 * 带标签的图类型额外关掉 `htmlLabels`：默认的 HTML 标签包在 `<foreignObject>` 里，
 * 它的大小由 HTML 内容布局决定，而 `getBBox()` 在服务端（jsdom）量不了 HTML——节点会退化成
 * 默认最小宽，几何不随内容变。改用具名 `<text>` 后，节点尺寸由等宽字体度量算出，服务端可复现。
 */
const LABELED_DIAGRAM_OFF = {
  useMaxWidth: false,
  htmlLabels: false,
  // 关闭自动换行：包装逻辑要在「一行能放多宽」上与浏览器布局逐像素一致，是服务端几何与真机
  // 分歧的主源。覆盖渲染本就要图的自然尺寸（长标签宽一点无妨），不换行反而让两侧几何可复现。
  wrappingWidth: 1_000_000,
} as const

/**
 * 交给 `mermaid.initialize` 的完整配置。**禁止在渲染路径里再传第二份配置**——
 * 那会让样式来源分叉，用户源码的 `%%{init}%%` 就有空子可钻。
 */
export const MERMAID_RENDER_CONFIG = {
  startOnLoad: false,
  securityLevel: MERMAID_SECURITY_LEVEL,
  theme: MERMAID_THEME,
  fontFamily: MERMAID_FONT_FAMILY,
  htmlLabels: false,
  themeVariables: MERMAID_THEME_VARIABLES,
  themeCSS: MERMAID_THEME_CSS,
  secure: [...MERMAID_SECURE_KEYS],
  flowchart: LABELED_DIAGRAM_OFF,
  class: LABELED_DIAGRAM_OFF,
  state: LABELED_DIAGRAM_OFF,
  er: LABELED_DIAGRAM_OFF,
  requirement: LABELED_DIAGRAM_OFF,
  sequence: INTRINSIC_SIZE_OFF,
  gantt: INTRINSIC_SIZE_OFF,
  journey: INTRINSIC_SIZE_OFF,
  pie: INTRINSIC_SIZE_OFF,
  gitGraph: INTRINSIC_SIZE_OFF,
  quadrantChart: INTRINSIC_SIZE_OFF,
  timeline: INTRINSIC_SIZE_OFF,
  mindmap: INTRINSIC_SIZE_OFF,
  sankey: INTRINSIC_SIZE_OFF,
  xyChart: INTRINSIC_SIZE_OFF,
  radar: INTRINSIC_SIZE_OFF,
}

/**
 * 剥离 `%%{ ... }%%` init 指令。花括号可嵌套、可跨行，故用单次字符扫描而非链式 replace
 * （同一份文本上多次正则替换会互相破坏，见 mermaid 归一化的既有纪律）。
 *
 * 返回仍保留行结构的新串：指令被吃掉的位置以换行占位，避免剥离后相邻两行粘成一行、
 * 影响下游「行首图形声明」这类按行判定的逻辑。
 *
 * OCR 文本来自屏幕截图、是完全不可信的输入；本函数是「外部内容不得改写 Treen 视觉」的唯一执行点。
 * 即使归一化阶段已剥过一遍，渲染站仍独立再剥一次（纵深防御，两侧同构）。
 */
export function stripMermaidInitDirectives(source: string): string {
  const length = source.length
  let out = ''
  let index = 0

  while (index < length) {
    if (source.startsWith('%%{', index)) {
      const atLineStart = out === '' || out.endsWith('\n')
      let depth = 1
      index += 3
      while (index < length && depth > 0) {
        const ch = source[index]
        if (ch === '{') {
          depth += 1
        } else if (ch === '}') {
          depth -= 1
        }
        index += 1
      }
      // 收尾的 `%%` 若在，一并吃掉。
      if (source.startsWith('%%', index)) {
        index += 2
      }
      // 独占整行的指令连同其换行一起吃掉，只补一个占位换行保持行结构；行内指令则以换行收尾，
      // 避免剥离后两侧文本粘连、行数错位。
      if (atLineStart && source[index] === '\n') {
        index += 1
      }
      out += '\n'
      continue
    }
    out += source[index]
    index += 1
  }

  return out
}
