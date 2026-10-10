/**
 * mermaid 结构检测：从 OCR 文本里挑出「疑似 mermaid 源码」的候选块。
 *
 * 检测与归一化是两件独立的事，且检测跑在归一化之前——判定「这段像不像图」不应依赖归一化是否成功，
 * 否则一段真正的图源码会因为箭头还没被修好而被判为非图。检测只做保守的结构判定，把「是不是有效图」
 * 的最终裁决交给下游的 mermaid.parse()。
 *
 * 判据是两条并列的候选条件（详见 detectMermaidBlocks）：「行首图形声明 + 含结构行」与
 * 「无声明但段内 ≥2 行像连线语句」。单看关键词会把正文误判成图（同屏正文里出现 graph 字样
 * 是常见情形），行形门槛 looksLikeStatementLine 把正文长句与垃圾行挡在外面。
 */

/** 一段疑似 mermaid 源码的候选块。 */
export interface MermaidCandidate {
  /** 候选块起始行在原文中的行号（0 基，含声明行） */
  startLine: number
  /** 候选块结束行在原文中的行号（0 基，含端点） */
  endLine: number
  /** 候选块原文（未归一化；行的连接符统一为 \n） */
  source: string
}

/** flowchart / graph 可跟的方向缩写，与关键字之间容忍空格缺失（OCR 常丢空格：graphLR）。 */
const FLOW_DIRECTIONS = 'lr|rl|tb|td|bt'

/**
 * 其余图类型关键字。比较时统一小写，以吸收 OCR 的大小写漂移（sequencediagram → sequenceDiagram）。
 * 这些关键字后必须是空白或行尾，避免把 sequenceDiagrams 之类的前缀误当声明。
 *
 * 此表与下方结构判据是**成对**的：只有连线/关系算子能被 `hasStructuralLine` 命中的图类型才可入表，
 * 否则声明的支持就是空的——块永远过不了结构判定，候选根本不会产出。像 gantt / pie / journey /
 * mindmap / timeline / gitGraph 这类靠「任务行、冒号项、缩进」而非连线表达结构的类型，需要各自
 * 的句式判据，当前不在本表内（列入待办，不占位假支持）。
 */
const OTHER_DECLARATIONS = [
  'sequencediagram',
  'classdiagram',
  'statediagram-v2',
  'statediagram',
  'erdiagram',
]

const FLOW_DECLARATION = new RegExp(`^(flowchart|graph)\\s*(${FLOW_DIRECTIONS})?\\s*(;.*)?$`, 'i')

/**
 * 一行是否是「行首图形声明」。允许缩进（先 trim），但不接受图类型关键字出现在行中——
 * 正文里的 graph 字样正因为不在行首而被排除。裸 `mermaid`（丢反引号的 fence 标识）不算声明，
 * 它由归一化的剥围栏处理。
 */
export function isDiagramDeclaration(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') {
    return false
  }
  if (FLOW_DECLARATION.test(trimmed)) {
    return true
  }
  const lower = trimmed.toLowerCase()
  return OTHER_DECLARATIONS.some((keyword) => lower === keyword || lower.startsWith(`${keyword} `) || lower.startsWith(`${keyword}\t`))
}

/**
 * 箭头形态。检测跑在归一化之前，故除规范箭头外还须接受 OCR 劣化形态（--》/一>/→ 等），
 * 否则带劣化箭头的真图会在检测阶段就被漏掉。宁可放宽：误收的候选由下游 parse 拒绝。
 */
const ARROW_PATTERNS: readonly RegExp[] = [
  /--*>/,
  /--*>>/,
  /->>/,
  /==>/,
  /--[ox]/,
  /o--/,
  /x--/,
  /-\.->/,
  /-\.-/,
  /[-=—–一]{1,3}\s*[>》〉→]/,
  /[→》〉]/,
]

/** 一行是否含箭头类 token。 */
export function hasArrow(line: string): boolean {
  return ARROW_PATTERNS.some((pattern) => pattern.test(line))
}

/**
 * 关系算子：classDiagram 与 erDiagram 的连线不带箭头头，靠两端花饰表达语义
 * （继承 `<|--`、实现 `..|>`、依赖 `..>`、ER 基数 `||--o{`）。字形匹配即可，语义仍归 parse 裁决。
 */
const RELATION_PATTERNS: readonly RegExp[] = [
  /<\|--/,
  /-->?\|>/,
  /<\|\.\./,
  /\.\.\|?>/,
  /\|\|--/,
  /--\|\|/,
  /\}\|--/,
  /--\|\{/,
  /\}o--/,
  /--o\{/,
  /\}o\.\./,
  /\.\.o\{/,
]

/**
 * 一行是否含图的结构行特征——箭头**或**关系算子。判据放宽的理由是代价不对称：误收的候选由下游
 * `parse()` 一句话否掉，漏掉的图却会静默消失。
 */
export function hasStructuralLine(line: string): boolean {
  return hasArrow(line) || RELATION_PATTERNS.some((pattern) => pattern.test(line))
}

const isBlank = (line: string): boolean => line.trim() === ''

/**
 * 行首标识符：mermaid 节点 id 的字符域（ASCII 字母/下划线起头，可含数字点连字符）。
 * 数字起头不收——正文里的「0.02 BPM …」这类以数字开头的行借此排除。
 */
const LEADING_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.-]*/

/**
 * 一行是否「像连线语句」：行首是标识符，且行内含结构特征（箭头/关系算子），或标识符后紧跟
 * 括号标签（`id[...]`、`id(...)`、`id{...}`）。这是无声明判据的行形门槛，收得比「含箭头」紧：
 * 中文正文长句不以 ASCII 标识符起头，箭头变形又混入正文的垃圾行（如 `A—-2作为参照系…`，
 * 标识符后既非箭头头也非括号）也进不来——误收正文当图渲染比漏收更糟。
 */
export function looksLikeStatementLine(line: string): boolean {
  const trimmed = line.trim()
  if (LEADING_IDENTIFIER.test(trimmed) === false) {
    return false
  }
  if (hasStructuralLine(trimmed)) {
    return true
  }
  return /^[A-Za-z0-9_.-]*\s*[[({]/.test(trimmed)
}

/**
 * 从文本里检出全部 mermaid 候选块。
 *
 * 块边界取「直到首个空行为止的连续非空段」——OCR 出的图源码内部通常没有空行，空行是最稳的
 * 分隔信号。产出候选的判据有两条，并列成立其一即可：
 *
 * 1. 声明行起头且段内（声明之后）至少一行含结构特征——历史判据；
 * 2. 无声明行，但段内至少两行像连线语句、且至少两行含结构特征——真机实测里 OCR 会把
 *    `graph LR` 整行认丢（连 fence 标识也不剩），声明判据下整块静默消失。结构行计数沿用
 *    hasStructuralLine（箭头或关系算子）而非仅箭头：无声明的 classDiagram 劣化段靠关系算子
 *    表达结构，只数箭头会让「有声明可检出、无声明检不出」不对称。
 *
 * 两条判据都不命中时，扫描从下一行继续（段内剩余部分可能以新段首命中）；命中时候选块的
 * source 吞整段——紧邻的正文行交由下游 parse 与装配层的语句行过滤裁决，不在检测层做
 * 猜测式裁剪。已知限制：同段内两张都丢了声明行的紧邻图没有任何文本层分隔信号，只会产出
 * 一个候选（有声明行的场景由装配层的 stopAt 拆分）。
 */
export function detectMermaidBlocks(text: string): MermaidCandidate[] {
  const lines = text.split(/\r?\n/)
  const blocks: MermaidCandidate[] = []

  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (isBlank(line)) {
      index += 1
      continue
    }

    let end = index
    while (end + 1 < lines.length && !isBlank(lines[end + 1] ?? '')) {
      end += 1
    }
    const segment = lines.slice(index, end + 1)

    // 段内含声明行时按声明判据、从声明行起块——段首可能是 fence 残留（裸 mermaid 标识行），
    // 它不是图的组成部分，留在 source 里会被下游整段拒绝。
    const declOffset = segment.findIndex(isDiagramDeclaration)
    if (declOffset >= 0) {
      if (segment.slice(declOffset + 1).some(hasStructuralLine)) {
        blocks.push({
          startLine: index + declOffset,
          endLine: end,
          source: segment.slice(declOffset).join('\n'),
        })
        index = end + 1
        continue
      }
      index += 1
      continue
    }

    const statementCount = segment.filter(looksLikeStatementLine).length
    const structuralCount = segment.filter(hasStructuralLine).length
    if (statementCount >= 2 && structuralCount >= 2) {
      // 几何锚点取段内首个语句行：整片选区常因观察间无空行而连成一段，段首可能是图上方的
      // 正文行——从它扩张会把矩形钉在正文上，图反而求不到区域。source 仍取整段交渲染裁决。
      const firstStatement = segment.findIndex(looksLikeStatementLine)
      blocks.push({ startLine: index + firstStatement, endLine: end, source: segment.join('\n') })
      index = end + 1
      continue
    }
    index += 1
  }

  return blocks
}
