import { isDiagramDeclaration } from './detect'
import { normalizeMermaid } from './normalize'
import type { ChatCompleter } from '../translation/deepseek'

/**
 * mermaid 源码的 LLM 修复（DeepSeek）纯逻辑：请求体构造、返回解析与可用性裁决。
 *
 * 职责是归一化做不到的那一段：归一化只做等价变形、不猜语义（见 normalize.ts 纪律），
 * 而 OCR 的语义级畸变（`|`→`1`、`]`→`1`、行首丢字、粘连正文的垃圾行）正需要「猜测式修复」——
 * 猜测改由 LLM 承担，合法性由渲染站裁决，修复不可用时落回规则候选，风险被两头兜住。
 *
 * 与批量翻译同构：协议形态与判断在这层可纯 Node 单测，网络出口经注入（deepseek-client.ts）。
 */

/** 修复模型档（provisional）：与翻译同域同档，升档只改这一处。 */
export const REFINE_MODEL = 'deepseek-flash'

/**
 * 修复要的是确定性而非创造性：比翻译的 0.2 更低。
 * 既往决策「采样参数交回 provider 默认」适用多 provider 网关，单 provider 实测调校的专用链路属其明示例外。
 */
const REFINE_TEMPERATURE = 0.1

/** 与批量翻译同量级的输出护栏：异常吐长不许把延迟拉爆。 */
const REFINE_MAX_TOKENS = 4096

/**
 * 修复结果源码长度上限（provisional）：一张图的 OCR 区域行远小于此，
 * 超过即模型在重写而非修复（或输出了无关内容），宁可不采纳。
 */
export const REFINE_MAX_SOURCE_CHARS = 12_000

const FENCE_PATTERN = /```(?:mermaid)?\s*\n?([\s\S]*?)```/i

/**
 * 构造一次 mermaid 修复请求。
 *
 * `response_format: json_object` 只约束顶层是对象，prompt 不显式指示 JSON 时模型可能吐空白
 * （官方文档警告，与批量翻译同一教训）；期望返回 `{"source": "..."}`。
 * 修复范围刻意收窄为「语法符号修复 + 非图垃圾行剔除」并要求保留声明行——
 * 结构重排与补写整段内容不在请求之列（幻觉敞口由数据示例逐步校准，不靠一次 prompt 封顶）。
 */
export function buildRefineBody(source: string): unknown {
  return {
    model: REFINE_MODEL,
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    temperature: REFINE_TEMPERATURE,
    max_tokens: REFINE_MAX_TOKENS,
    messages: [
      {
        role: 'system',
        content:
          '你是 mermaid 源码修复引擎。输入是 OCR 识别出的 mermaid 文本，含识别畸变。' +
          '只做两件事：1) 修复语法符号级畸变（如竖线被认成 1 或 I、右括号被认成 1、全角括号引号、粘连的箭头）；' +
          '2) 删除明显不属于图的垃圾行（行号列、编辑器界面文字、UI 噪声）。' +
          '保留图类型声明行（flowchart/graph 等）；尽量保持原有结构与内容，不改写节点文案，不补写臆测的新语句。' +
          '只输出 JSON：{"source": "修复后的完整源码字符串"}，不要解释、不要代码围栏。',
      },
      {
        role: 'user',
        content: `请修复并按 {"source": "..."} 返回：\n${source}`,
      },
    ],
  }
}

/**
 * 从模型返回解出可用的修复源码：解析形态 → 再过一次 `normalizeMermaid` → 可用性裁决。
 *
 * 过归一化不是保险而是纪律的一部分：`%%{init}%%` 剥离是「外部内容不得决定 Treen 视觉」的
 * 唯一执行点，LLM 输出同属不可信外部内容；模型把箭头写回劣化形态时规则归一也是免费的。
 * 解析兼容三种漂移形态——约定对象、裸字符串 JSON、围栏包裹的非 JSON——都收，因为拒掉的
 * 代价只是落回规则候选（不坏于现状），而漏收的代价是必经步骤白付一次调用。
 * 拒绝条件：解不出源码、归一后为空、无声明行（修复版必须带声明，默认声明的补全是候选层的
 * 事、不指望模型顺手补回）、超长。返回 null 由调用方落回兜底序列。
 */
export function parseRefineResponse(content: string): string | null {
  let candidate: string | null = null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    parsed = null
  }
  if (typeof parsed === 'string') {
    candidate = parsed
  } else if (parsed !== null && typeof parsed === 'object') {
    const source = (parsed as { source?: unknown }).source
    if (typeof source === 'string') {
      candidate = source
    }
  }
  if (candidate === null) {
    const fenced = FENCE_PATTERN.exec(content)
    if (fenced !== null) {
      candidate = fenced[1] ?? ''
    } else {
      // 非 JSON 非围栏：整段当源码候选尝试救回——拒与收的判据统一交给下游归一化与声明行，
      // 不在这里多猜一层「像不像回答」。
      candidate = content
    }
  }

  const normalized = normalizeMermaid(candidate)
  const trimmed = normalized.trim()
  if (trimmed === '' || trimmed.length > REFINE_MAX_SOURCE_CHARS) {
    return null
  }
  if (!trimmed.split('\n').some(isDiagramDeclaration)) {
    return null
  }
  return trimmed
}

export interface MermaidRefinerDeps {
  complete: ChatCompleter
}

/**
 * 生成「修复一段 mermaid 源码」的动作：构体、发一跳、解析裁决，成品是归一后的可送渲染源码。
 *
 * 失败一律抛错而非返回 null 或原文：必经步骤的「不可用」必须是调用方 catch 得到的显式信号，
 * 静默回退原文会把「模型没帮上忙」伪装成「修复成功」，把归因搅浑。出口错误原样上抛——
 * 降级（落回规则候选序列）是装配层的决策，不在这里越权。
 */
export function createMermaidRefiner(deps: MermaidRefinerDeps) {
  return async (source: string): Promise<string> => {
    const refined = parseRefineResponse(await deps.complete(buildRefineBody(source)))
    if (refined === null) {
      throw new Error('LLM 修复返回不可用（解析不出、无声明行或超长），落回规则候选')
    }
    return refined
  }
}
