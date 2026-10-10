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

/**
 * 图类型关键字的大小写规范形（仅列 OCR 可能小写化、且 mermaid 大小写敏感的那些）。
 * 键集与 detect 的声明表一致：只有能被检出的类型才需要在此修正大小写。
 */
const CANONICAL_KEYWORD: Readonly<Record<string, string>> = {
  sequencediagram: 'sequenceDiagram',
  classdiagram: 'classDiagram',
  'statediagram-v2': 'stateDiagram-v2',
  statediagram: 'stateDiagram',
  erdiagram: 'erDiagram',
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
 * 源码是否声明为 sequenceDiagram：声明行给出图类型上下文，sequence 的 `-->>` 是合法异步
 * 消息，全角箭头劣化形（`-》>`）不该被压成实线。声明丢失时（S14 的主缺陷场景）按默认图
 * flowchart 处置——`-->>` 会被 parse 拒，收窄让图能出；此时 sequence 的劣化异步消息会
 * 降级为实线箭头，图仍出，比整块消失好。
 */
function declaresSequenceDiagram(source: string): boolean {
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue
    }
    return /^sequenceDiagram\b/i.test(line.trim())
  }
  return false
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
  // sequence 上下文不吃全角箭头后的裸 >（见 declaresSequenceDiagram）。
  const keepTrailingClose = declaresSequenceDiagram(source)

  while (index < length) {
    const ch = source[index] ?? ''

    if (initDepth > 0) {
      if (ch === '{') {
        initDepth += 1
      } else if (ch === '}') {
        initDepth -= 1
        if (initDepth === 0 && source.startsWith('%%', index + 1)) {
          index += 3
          // 指令独占整行时就连同其换行一起吃掉，该行不留痕迹；行内指令则以一个换行收尾，
          // 避免剥离后两侧文本粘连、行结构坍塌影响行首判定。
          if (source[index] === '\n') {
            index += 1
          } else {
            out += '\n'
          }
          atLineStart = true
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
        // 虚线箭头/虚线连线（-.-> / -.-）语义独立于实线，须整体识别。OCR 可能在笔画之间塞进空格
        // （- . ->），故匹配时容忍空格，命中后一律输出规范形。
        const dashedArrow = /^-\s*\.\s*->/.exec(source.slice(index))
        if (dashedArrow !== null) {
          out += '-.->'
          index += dashedArrow[0].length
          continue
        }
        const dashedLine = /^-\s*\.\s*-/.exec(source.slice(index))
        if (dashedLine !== null) {
          out += '-.-'
          index += dashedLine[0].length
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
        // OCR 对破折号笔画的误识常连带产出多余的裸 `>`（`-→>` 是 -、→、> 三段），flowchart
        // 拒收 `-->>`（mermaid.parse 实测），故全角箭头归一后把紧邻的裸 > 一并吃掉。纯 ASCII
        // 的 ->> / -->> 走上方分支不经这里；sequence 声明在场时也不吃——`-》>` 的真源多半
        // 是合法的异步消息 `-->>`。
        if (!keepTrailingClose) {
          while (source[index] === '>') {
            index += 1
          }
        }
        continue
      }

      if (headChar === '-') {
        // 断裂的箭头笔画：OCR 把一支箭头拆成两段（- --> / - - >）。拆开的形态必然解析失败，
        // 合并成单箭头不损失任何合法输入；是否真是图仍由渲染裁决。含点的虚线形态在上面
        // 已整体识别，不会走到这里。
        const merged = /^[-—–一]+(?:\s*[-—–一]+)+\s*(?:>|》|〉|→)/.exec(source.slice(index))
        if (merged !== null) {
          out += '-->'
          index += merged[0].length
          continue
        }
      }

      const runLength = cursor - index
      if (
        runLength >= 2 &&
        headChar >= '0' &&
        headChar <= '9' &&
        '|[({'.includes(source[head + 1] ?? '')
      ) {
        // 箭头的尖被认成数字（--2|标签）：破折号段（两横以上）后紧跟数字、数字后紧跟结构符，
        // 不构成任何合法 mermaid 语法（合法的节点 id A-2 是单横且直接粘连，runLength 已排除），
        // 故把数字当误读的箭头尖吃掉。数字后是空白或字母的（正文「- 2 拍」）一律不动。
        out += '-->'
        index = head + 1
        continue
      }

      if (
        runLength === 1 &&
        (out.trimEnd().endsWith(']') || out.trimEnd().endsWith(')')) &&
        /[A-Za-z0-9_[({［（]/.test(headChar)
      ) {
        // 孤立单短横夹在两个节点形态之间（X] - Y[）：OCR 只认出了 --> 的一横。单横连线
        // 不是合法语法，补成箭头不损失合法输入；两侧限定节点边界（前一个产出字符是节点
        // 形状收口、后一个非空白字符是节点起头），正文的项目符号「- 文本」不会命中。
        out += '-->'
        index = cursor
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
      // 与 dash 后全角箭头的分支同理：紧邻的裸 > 是同一轮误识的连带产物，一并吃掉。
      if (!keepTrailingClose) {
        while (source[index] === '>') {
          index += 1
        }
      }
      continue
    }

    // <br/> 的 OCR 劣化族归一（S14）：`<` 被误识成 `s`（sbr/>）、`<` 整个丢失（br/>）、
    // 尾尖括号变全角（<br/›）、尾巴整体被吃（<br 后跟空格/行尾/>）。换行标签只出现在节点
    // 标签内，归一作用面已被检测收窄到候选块；<br 后跟字母区分不了 <break 与粘连劣化，
    // 保守保留原样。匹配按前缀从长到短，sbr/> 先于 br/> 才不会留下悬空的 s。
    if (source.startsWith('sbr/>', index)) {
      out += '<br/>'
      index += 5
      continue
    }
    if (source.startsWith('br/>', index)) {
      out += '<br/>'
      index += 4
      continue
    }
    if (ch === '<') {
      if (source.startsWith('<br/>', index)) {
        out += '<br/>'
        index += 5
        continue
      }
      if (source.startsWith('<br/', index) && (source[index + 4] === '›' || source[index + 4] === '〉' || source[index + 4] === '》')) {
        out += '<br/>'
        index += 5
        continue
      }
      if (source.startsWith('<br', index)) {
        const immediate = source[index + 3] ?? ''
        if (immediate === ']' || immediate === ')' || immediate === '}' || immediate === '') {
          // 尾巴被 OCR 整体吃掉，补全即可（闭括号/行尾不是尾巴的一部分）。
          out += '<br/>'
          index += 3
          continue
        }
        // <br> 与 <br > 是 mermaid 最常见的多行标签写法，尾巴消费到 > 为止，
        // 归一后不得在标签里多出字面 >。
        let cursor = index + 3
        while (source[cursor] === ' ') {
          cursor += 1
        }
        if (source[cursor] === '>') {
          out += '<br/>'
          index = cursor + 1
          continue
        }
        if (immediate === ' ') {
          // <br 与后续文本之间只隔一个空格：按缺尾劣化补全，空格留给原文。
          out += '<br/>'
          index += 3
          continue
        }
      }
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
