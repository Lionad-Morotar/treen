import { isDiagramDeclaration } from './detect'

/**
 * 把 OCR 出来的 mermaid 源码归一成可被 mermaid 解析的形态。
 *
 * 核心纪律是**单次字符扫描**：读到一个 token 就一次判定、吃掉整段并输出规范形态，绝不回头重扫已产出的
 * 文本。链式 replace 会互相破坏——箭头规则产出的 `-->` 又会被下一条规则匹配成 `--> >`，
 * 竖线还原规则会误伤含字母 l/I 的普通文本并把 `Alice ->> Bob` 毁成 `A|ce --> >> Bob`。
 *
 * 归一化只做**不影响语义的等价变形**（箭头笔画的误识、全角/半角、丢空格、被 OCR 带进来的围栏与 init
 * 指令）。语义级的误识（节点 `[]` 变成 `{}`、边标签竖线被认成字母）不在这里猜测式修复，原样交给
 * mermaid 报错并呈现给用户。
 *
 * init 指令剥离与本遍归一化同在其中：它是「用户不能控制样式」这条产品约束的唯一执行点——OCR 文本是
 * 外部应用的截图内容，不可信，若其中含 `%%{init}%%` 就会让外部内容决定 Treen 的视觉。
 */

/** 全角字符到半角的等价映射：只覆盖会破坏 mermaid 语法的括号与竖线。 */
const FULLWIDTH: Readonly<Record<string, string>> = {
  '【': '[',
  '】': ']',
  '［': '[',
  '］': ']',
  '（': '(',
  '）': ')',
  '＜': '<',
  '＞': '>',
  '｜': '|',
}

/** 图类型关键字的大小写规范形（仅列 OCR 可能小写化、且 mermaid 大小写敏感的那些）。 */
const CANONICAL_KEYWORD: Readonly<Record<string, string>> = {
  sequencediagram: 'sequenceDiagram',
  classdiagram: 'classDiagram',
  'statediagram-v2': 'stateDiagram-v2',
  statediagram: 'stateDiagram',
  erdiagram: 'erDiagram',
  gitgraph: 'gitGraph',
  quadrantchart: 'quadrantChart',
  requirementdiagram: 'requirementDiagram',
  c4context: 'C4Context',
  c4container: 'C4Container',
  c4component: 'C4Component',
  c4dynamic: 'C4Dynamic',
  c4deployment: 'C4Deployment',
}

/** 破折号类字符：ASCII 连字符与几种全角/长横线，都是 OCR 对 `-` 的等价变体。 */
const isDash = (ch: string): boolean => ch === '-' || ch === '—' || ch === '–' || ch === '一'

/** 围栏行：三反引号或三波浪号起头的行。 */
const isFenceLine = (line: string): boolean => /^\s*(`{3,}|~{3,})/.test(line)

/** 丢失反引号的裸 fence 标识行。 */
const isBareLanguageTag = (line: string): boolean => line.trim().toLowerCase() === 'mermaid'

/**
 * 图声明行的规范化：核心是补回 `graph`/`flowchart` 与方向缩写之间被 OCR 吞掉的空格，并修正图类型关键字
 * 的大小写。返回 null 表示这一行不是声明行（由调用方按普通行处理）。
 */
function canonicalizeDeclarationLine(line: string): string | null {
  if (!isDiagramDeclaration(line)) {
    return null
  }
  const indent = /^\s*/.exec(line)?.[0] ?? ''
  const body = line.slice(indent.length)

  const flow = /^(flowchart|graph)\s*(lr|rl|tb|td|bt)?/i.exec(body)
  if (flow !== null) {
    const keyword = (flow[1] ?? '').toLowerCase()
    const direction = flow[2]
    const rest = body.slice(flow[0].length)
    return `${indent}${keyword}${direction === undefined ? '' : ` ${direction.toUpperCase()}`}${rest}`
  }

  const word = /^[A-Za-z0-9-]+/.exec(body)?.[0]
  const canonical = word === undefined ? undefined : CANONICAL_KEYWORD[word.toLowerCase()]
  if (word !== undefined && canonical !== undefined) {
    return `${indent}${canonical}${body.slice(word.length)}`
  }
  return line
}

/**
 * 归一化一段（候选）mermaid 源码。返回仍保留行结构的新字符串。
 */
export function normalizeMermaid(source: string): string {
  const length = source.length
  let out = ''
  let index = 0
  let atLineStart = true
  // >0 表示正处于 `%%{ ... }%%` 指令内部（花括号可嵌套、可跨行）。
  let initDepth = 0

  while (index < length) {
    const ch = source[index] ?? ''

    if (initDepth > 0) {
      if (ch === '{') {
        initDepth += 1
      } else if (ch === '}') {
        initDepth -= 1
        if (initDepth === 0 && source.startsWith('%%', index + 1)) {
          // 以换行占位而非直接删除：避免剥离后行结构坍塌、把相邻两行粘成一行影响行首判定。
          out += '\n'
          index += 3
          atLineStart = false
          continue
        }
      }
      index += 1
      continue
    }

    if (ch === '%' && source.startsWith('%%{', index)) {
      initDepth = 1
      index += 3
      continue
    }

    if (atLineStart) {
      atLineStart = false
      const newline = source.indexOf('\n', index)
      const lineEnd = newline === -1 ? length : newline
      const line = source.slice(index, lineEnd)

      if (isFenceLine(line) || isBareLanguageTag(line)) {
        index = lineEnd
        continue
      }
      const declaration = canonicalizeDeclarationLine(line)
      if (declaration !== null) {
        out += declaration
        index = lineEnd
        continue
      }
    }

    if (ch === '\n') {
      out += '\n'
      index += 1
      atLineStart = true
      continue
    }

    if (isDash(ch)) {
      let cursor = index
      while (cursor < length && isDash(source[cursor] ?? '')) {
        cursor += 1
      }
      let head = cursor
      while (head < length && source[head] === ' ') {
        head += 1
      }
      const headChar = source[head] ?? ''

      if (headChar === '.') {
        // 虚线箭头/虚线连线（-.-> / -.-）语义独立，形态精确时整体保留。
        if (source.startsWith('-.->', index)) {
          out += '-.->'
          index += 4
          continue
        }
        if (source.startsWith('-.-', index)) {
          out += '-.-'
          index += 3
          continue
        }
      }

      if (headChar === '>') {
        if (source[head + 1] === '>') {
          // ->> / -->> 是 sequenceDiagram 的合法箭头，压成 --> 会改语义，整体保留。
          out += source.slice(index, head + 2)
          index = head + 2
          continue
        }
        out += '-->'
        index = head + 1
        continue
      }

      if (headChar === '》' || headChar === '〉' || headChar === '→') {
        out += '-->'
        index = head + 1
        continue
      }

      // 后面不是箭头头：多半是 `--` 连线或标签里的普通连字符，原样保留这段破折号。
      out += source.slice(index, cursor)
      index = cursor
      continue
    }

    if (ch === '→' || ch === '》' || ch === '〉') {
      out += '-->'
      index += 1
      continue
    }

    const mapped = FULLWIDTH[ch]
    if (mapped !== undefined) {
      out += mapped
      index += 1
      continue
    }

    out += ch
    index += 1
  }

  return out
}
