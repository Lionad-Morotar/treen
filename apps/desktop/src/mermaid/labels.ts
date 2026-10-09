/**
 * mermaid 源码节点主标签的提取与替换（图内文案翻译的文本变换层）。
 *
 * 输入必须是归一化之后的源码：全角括号已被归一成半角、箭头已修复，这里的括号匹配
 * 只需认半角形态。实现遵守本目录的单次扫描纪律——一个 token 一次判定、吃掉整段，
 * 绝不回头重扫已产出的文本；collect（收集标签）与 apply（替换标签）共享同一个
 * 扫描器，替换逻辑因此只有一份，不会出现「收集认得的形态替换时不认」的漂移。
 *
 * 范围刻意收窄：只认 `id[文案]`、`id(文案)`、`id{文案}`、`id((文案))` 四种主标签形态。
 * 边标签（`-->|文案|`）不是括号形态天然不命中；平行四边形 `[/…/]`、六边形 `{{…}}`、
 * 子例程 `[[…]]` 等未列形态原样保留——「先窄后宽」，未认得的形态留给后续切片。
 * 节点 id 一律不动：它是结构锚点，图靠它连线。
 */

/** 标签内不允许裸出现的字符（会改变 mermaid 源码结构），出现即强制引号包裹。 */
const STRUCTURAL = new Set(['"', '[', ']', '(', ')', '{', '}', '|'])

const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch)

interface LabelMatch {
  /** 匹配段的起点（id 首字符） */
  start: number
  /** 匹配段的终点（exclusive，最后一个闭括号之后） */
  end: number
  /** 节点 id（保持原样输出） */
  id: string
  /** 括号形态的 openers 与 closers（`((` 时各长 2） */
  openers: string
  closers: string
  /** 标签文本；quoted 时不含两侧引号 */
  label: string
  /** 原文是否用引号包裹了标签 */
  quoted: boolean
}

/**
 * 从 pos 起尝试匹配一个「id + 括号标签」段。不是标签形态（括号不配对、未认得的括号
 * 变体如 `[/…/]`、`{{…}}`）返回 null，调用方原样保留这些字符。
 */
function matchLabel(line: string, pos: number): LabelMatch | null {
  let idEnd = pos
  while (idEnd < line.length && isIdentChar(line[idEnd] ?? '')) {
    idEnd += 1
  }
  const id = line.slice(pos, idEnd)
  const opener = line[idEnd]
  if (opener !== '[' && opener !== '(' && opener !== '{') {
    return null
  }
  const closer = opener === '[' ? ']' : opener === '(' ? ')' : '}'

  // 平行四边形 `[/…/]`、`[\…\]` 与双花 `{{…}}` 不在本切片范围，让它们保持不命中。
  const next = line[idEnd + 1] ?? ''
  if (opener === '(' && next === opener && line[idEnd + 2] === opener) return null
  if (opener === '{' && next === opener) return null
  if ((opener === '[' || opener === '(') && (next === '/' || next === '\\')) return null

  // 连续 opener 计数（`(())` 为 2）；closer 不在内容扫描里消费，统一留给闭合段，
  // 避免「主循环吃一个、闭合段再吃一个」的双重递减把合法形态误判成不配对。
  let depth = 0
  let cursor = idEnd
  while (line[cursor] === opener) {
    depth += 1
    cursor += 1
  }
  const openers = line.slice(idEnd, cursor)

  const quoted = line[cursor] === '"'
  let label: string
  if (quoted) {
    const closeQuote = line.indexOf('"', cursor + 1)
    // 缺闭引号视为不匹配：半截的引号形态多半是 OCR 劣化，替换只会放大损坏。
    if (closeQuote === -1) {
      return null
    }
    label = line.slice(cursor + 1, closeQuote)
    cursor = closeQuote + 1
  } else {
    const begin = cursor
    while (cursor < line.length) {
      const ch = line[cursor] ?? ''
      if (ch === opener) {
        depth += 1
      } else if (ch === closer) {
        break
      }
      cursor += 1
    }
    if (cursor >= line.length) {
      return null
    }
    label = line.slice(begin, cursor)
  }

  // 闭合段：从 cursor 起期望连续 depth 个 closer，少一个都是不配对（OCR 劣化的半截形态）。
  const closeBegin = cursor
  while (cursor < line.length && line[cursor] === closer && depth > 0) {
    depth -= 1
    cursor += 1
  }
  if (depth !== 0) {
    return null
  }
  return { start: pos, end: cursor, id, openers, closers: line.slice(closeBegin, cursor), label, quoted }
}

/** 清理译文：换行折成空格（标签内换行会断开源码行结构），两侧空白修剪。 */
function sanitize(translation: string): string {
  return translation.replace(/\r\n?|\n/g, ' ').trim()
}

/** 译文按原文的包裹形态写回；裸写会破坏结构时强制引号包裹并转义内嵌引号。 */
function rewriteLabel(match: LabelMatch, translation: string): string {
  const cleaned = sanitize(translation)
  const dangerous = [...cleaned].some((ch) => STRUCTURAL.has(ch))
  const quoted = match.quoted || dangerous
  const inner = quoted ? `"${cleaned.replaceAll('"', '#quot;')}"` : cleaned
  return `${match.id}${match.openers}${inner}${match.closers}`
}

export interface NodeLabelRewrite {
  /** 扫描后的源码；visit 对每个标签返回 null 时与输入一致 */
  output: string
  /** 按首次出现序去重后的全部标签（含 visit 返回 null 的） */
  labels: string[]
}

/**
 * 单次扫描源码，对每个节点主标签调用 visit：返回替换文本（null/undefined = 保留原文）。
 * 替换段以 `rewriteLabel` 的形态重构，其余字符逐个原样输出。
 */
export function mapNodeLabels(source: string, visit: (label: string) => string | null): NodeLabelRewrite {
  const labels: string[] = []
  const seen = new Set<string>()
  const output = source
    .split('\n')
    .map((line) => {
      // 整行注释不是图结构文案，翻译它没有意义还可能误改示例源码。
      if (line.trim().startsWith('%%')) {
        return line
      }
      let out = ''
      let index = 0
      while (index < line.length) {
        const ch = line[index] ?? ''
        if (isIdentChar(ch) && (index === 0 || !isIdentChar(line[index - 1] ?? ''))) {
          const match = matchLabel(line, index)
          if (match !== null) {
            if (!seen.has(match.label)) {
              seen.add(match.label)
              labels.push(match.label)
            }
            const replacement = visit(match.label)
            out += replacement === null || replacement === undefined ? line.slice(index, match.end) : rewriteLabel(match, replacement)
            index = match.end
            continue
          }
        }
        out += ch
        index += 1
      }
      return out
    })
    .join('\n')
  return { output, labels }
}

/** 收集源码里全部节点主标签（首次出现序、去重）。 */
export function collectNodeLabels(source: string): string[] {
  return mapNodeLabels(source, () => null).labels
}
