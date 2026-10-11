import { detectMermaidBlocks, hasStructuralLine, isDiagramDeclaration, looksLikeStatementLine } from '../mermaid/detect'
import { collectNodeLabels, mapNodeLabels } from '../mermaid/labels'
import { normalizeMermaid } from '../mermaid/normalize'
import type { MermaidRenderResult } from '../render'
import { chartRegionMembers, rectOfMembers, type PlacedObservation } from './chart-region'
import { planOverlay, type OverlayChartInput, type OverlayPlan, type OverlayTextInput } from './layout'
import type { Rect } from '../geometry'

/**
 * 覆盖计划的装配：把翻译链路的产物（带屏幕落点的译文块）拼成渲染层能直接消费的计划。
 *
 * 这里是图表落点的关键决策点，串起三件事：
 * 1. 用 OCR 观察的文字还原源码文本，做 mermaid 候选检测（声明行丢失的段靠语句行判据兜住）；
 * 2. 对每个候选，以「声明或段首所在观察」为锚点，用几何连续性求出它占住的那几行，并得到矩形；
 * 3. 把那几行归一化后（无声明候选补默认声明），经 LLM 修复恰一次（注入时；每张图的主送源），
 *    连同降级为安全网的规则候选一起逐个送渲染站拿 SVG，按 contain 适配进那个矩形。
 *
 * 源码取「屏幕上占住的那几行」而非检测出的整块，是这里最容易看错的一点：检测以空行划界，而截图里
 * 的图后面往往紧跟正文，整块喂给渲染站只会换回一句语法错，图就静默消失了。屏幕矩形已由几何求出，
 * 用它裁剪源码，「渲染的图」与「它覆盖的区域」于是是同一批行。
 *
 * 校验即渲染：候选是否「真是一张图」由渲染站裁决（渲染成功才算命中），因此主进程不必再背一份
 * mermaid + jsdom。渲染站不可达或语法非法时该候选被跳过（记日志），译文照常覆盖——一块图消失
 * 不该让整片译文一起失败。
 *
 * 图内节点文案的翻译发生在渲染之前：基于归一化后的源码替换节点主标签（只动标签文字，节点 id 与
 * 边标签不碰），替换后的源码先送渲染站，被拒（翻译内容让源码不合法）或翻译本身失败时退回原文
 * 版本再试——译文的归宿是「锦上添花」，任何一步不成立图都照常出来。
 */

/** 翻译链路交出的一段译文：source 为识别到的原文，translation 为译文，box 为其屏幕落点。 */
export interface OverlayBlock {
  source: string
  translation: string
  box: Rect
}

export interface ComposeOverlayDeps {
  /**
   * 送渲染站渲染一段 mermaid 源码；失败抛错。
   * 缺省即不产图表——「翻译图表」开关关闭时装配层就不注入它，比让 compose 再读一次开关更直白，
   * 也省掉整段 mermaid 检测与网络往返。
   */
  render?(source: string): Promise<MermaidRenderResult>
  /**
   * 批量翻译节点主标签，返回与输入等长的译文；失败抛错。
   * 缺省即不翻译节点文案——「翻译图内文案」开关关闭时不注入，同 render 的取舍；
   * 源码里没有节点标签时也不会被调用，省下那次外部调用。
   */
  translateLabels?(labels: readonly string[]): Promise<string[]>
  /**
   * 用 LLM 修复一段 mermaid 源码（语义级畸变归一化救不了，猜测交给模型、合法性由渲染站裁决）；
   * 不可用时抛错。链路上的必经步骤：图表装配每检测出一张图都会以它的首个规则候选（全区域归一版）
   * 调用恰一次，修复版作为主送源排在尝试序列最前；抛错或产物与输入等同时落回规则候选序列。
   * 缺省（未配密钥等）时行为与无修复链路完全一致。
   */
  refine?(source: string): Promise<string>
  /** 是否产出译文覆盖；缺省 true。关闭时仍照常检测图表（图不需要译文，只需源码文本）。 */
  texts?: boolean
  logger?: { warn(message: string): void; info(message: string): void }
}

/**
 * 一个候选块值得送渲染站的源码，按尝试次序排列（最保守 → 最像图）；`memberIndices` 是它覆盖的
 * 成员下标（几何区域成员数组内的下标，供重算版位）——语句行过滤丢的是中间的垃圾行，候选不再
 * 恒为区域的「前缀切片」，行数不足以表达覆盖范围。
 *
 * 候选序列（S14 起）：
 * 1. 区域内全部行（历史首选）；
 * 2. 全区域的尾部裁剪版——图后紧邻正文时（空行常被 OCR 丢掉），砍掉最后一条连线行之后的行；
 * 3. 只保留像语句的行——真机实测里图的行间会混进箭头变形又粘连正文的垃圾行，整段注定渲染失败
 *    而图本身是好的，丢掉垃圾行再试；
 * 4. 上一条的尾部裁剪版。
 *
 * **保守在前是刻意反转**（锚点原写「最像图 → 最保守」，审查实证后推翻）：subgraph、participant、
 * Note、classDef 这类合法的非语句行会被过滤候选丢掉，而裁掉后源码依然合法——渲染站裁决不出
 * 内容缺失，过滤候选若排前且命中，一张缺内容的错图就静默落地，被丢行的译文又被图版位抑制，
 * 内容双向丢失。故过滤候选只作 fallback：全区域先试（渲染站拒掉含垃圾行的源码），拒了才轮到
 * 裁剪。它还须至少含一条结构行才产出——全过滤只剩裸声明时会渲染出空图盖住声明行。
 *
 * 只砍尾部的非连线行、过滤只丢不像语句的行：按检测层自己的判据，连线行才是图的结构，动它们才
 * 可能得到与屏幕不符的图。这是**由渲染站裁决**的裁剪，不是对行义的猜测。相同覆盖范围的候选
 * 只保留一条（两种裁剪在特定输入下会撞出同一行集，重复送渲染白付一次往返）。
 *
 * 候选块没有声明行时补默认声明 `graph LR`：方向缩写只有在 OCR 明确认出（声明行在场）时才采信，
 * 认不出就用默认——猜方向没有依据。
 */
export function chartSourceCandidates(lines: readonly string[]): Array<{ source: string; memberIndices: number[] }> {
  const allIndices = lines.map((_, index) => index)
  const hasDeclaration = lines.some(isDiagramDeclaration)
  const candidates: Array<{ source: string; memberIndices: number[] }> = []

  const push = (memberIndices: readonly number[]): void => {
    const last = candidates[candidates.length - 1]
    if (last !== undefined && last.memberIndices.length === memberIndices.length && last.memberIndices.every((value, i) => value === memberIndices[i])) {
      return
    }
    const body = memberIndices.map((index) => lines[index] ?? '').join('\n')
    const source = hasDeclaration ? normalizeMermaid(body) : normalizeMermaid(`graph LR\n${body}`)
    candidates.push({ source, memberIndices: [...memberIndices] })
  }

  push(allIndices)
  const lastStructural = allIndices.reduce(
    (last, index) => (hasStructuralLine(lines[index] ?? '') ? index : last),
    -1,
  )
  if (lastStructural >= 0 && lastStructural < allIndices.length - 1) {
    push(allIndices.slice(0, lastStructural + 1))
  }

  // 过滤集合恒含声明行：声明行不是语句行，但它是图的组成，滤掉它会让候选失去声明。
  const statementIndices = allIndices.filter(
    (index) => looksLikeStatementLine(lines[index] ?? '') || isDiagramDeclaration(lines[index] ?? ''),
  )
  if (
    statementIndices.length > 0 &&
    statementIndices.length < allIndices.length &&
    statementIndices.some((index) => hasStructuralLine(lines[index] ?? ''))
  ) {
    push(statementIndices)
    const lastStructuralInStatement = statementIndices.reduce(
      (last, index, position) => (hasStructuralLine(lines[index] ?? '') ? position : last),
      -1,
    )
    if (lastStructuralInStatement >= 0 && lastStructuralInStatement < statementIndices.length - 1) {
      push(statementIndices.slice(0, lastStructuralInStatement + 1))
    }
  }

  return candidates
}

/**
 * 一张图的「标签 → 译文」对照表；翻译不适用（未注入、无标签、调用失败）时为 null，
 * 候选照常用原文。标签集合取首个候选（全区域行）——后续候选是它的裁剪子集，
 * 一张图只需一次外部调用，裁剪候选不必重译。
 */
async function chartLabelLookup(
  sources: readonly string[],
  translateLabels: ((labels: readonly string[]) => Promise<string[]>) | undefined,
  logger?: { warn(message: string): void; info(message: string): void },
): Promise<Map<string, string | null> | null> {
  if (translateLabels === undefined || sources.length === 0) {
    return null
  }
  try {
    // 候选按「语句行过滤 → 全区域」排列，取首个建对照表（S14 起首个不再恒为后续候选的超集）：
    // 被过滤掉的垃圾行里的括号文本不进集合，省下白付的 token；某候选若含对照表外的标签，
    // mapNodeLabels 对缺失标签保留原文，图不受影响。
    const labels = collectNodeLabels(sources[0] ?? '')
    // 一条节点标签都没有（纯连线图）：那次外部调用也省下。
    if (labels.length === 0) {
      return null
    }
    const translations = await translateLabels(labels)
    // 等长是注入实现的契约（批量翻译器内部已保证）；违约宁可弃用译文，也不交出与标签错位的图。
    if (translations.length !== labels.length) {
      throw new Error(`节点文案译文 ${translations.length} 条与原文 ${labels.length} 条不一致`)
    }
    return new Map(labels.map((label, index) => [label, translations[index] ?? null]))
  } catch (error) {
    logger?.warn(
      `节点文案翻译失败，图用原文渲染：${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

/**
 * 对这张图的全区域规则归一版做恰一次 LLM 修复；返回可用修复版，或 null（未注入、调用抛错、
 * 产物与输入逐字节相同）。
 *
 * 抛错在这里就被吞掉并落回 null：降级是「图链退回规则候选序列」，本就是修复步骤的失败形态，
 * 装配层不需要第二个处理点。产物与输入相同即模型认为无需修，再当独立尝试送渲染是复走规则
 * 序列首选的重复往返。
 */
async function refineChartSource(
  refine: ((source: string) => Promise<string>) | undefined,
  first: { source: string } | undefined,
  logger?: { warn(message: string): void; info(message: string): void },
): Promise<string | null> {
  if (refine === undefined || first === undefined) {
    return null
  }
  try {
    const refined = await refine(first.source)
    return refined === first.source ? null : refined
  } catch (error) {
    logger?.warn(
      `LLM 修复失败，落回规则候选：${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}

/**
 * 把选区里的 mermaid 候选逐个变成图表版位。渲染方由调用方给定——它缺席时整个函数不会被调用。
 * 每个候选的取舍（几何求区域、区域裁剪源码、渲染站裁决、候选序列）见文件头的说明。
 */
async function composeCharts(
  observations: readonly PlacedObservation[],
  sourceText: string,
  region: Rect,
  render: (source: string) => Promise<MermaidRenderResult>,
  deps: Pick<ComposeOverlayDeps, 'translateLabels' | 'refine' | 'logger'>,
): Promise<OverlayChartInput[]> {
  const { translateLabels, refine, logger } = deps
  const charts: OverlayChartInput[] = []
  for (const candidate of detectMermaidBlocks(sourceText)) {
    const members = chartRegionMembers(observations, candidate.startLine, {
      bound: region,
      // 上下紧邻的两张图既没有空行分隔（或被 OCR 丢掉），行距又与图内行距一样小，纯几何分不开；
      // 而「这一行是另一张图的声明」是文本层的事，由这里注入。不注入的话上图会把下图整块吞掉，
      // 双声明的源码必然渲染失败，两张图一起消失。
      stopAt: (observation, index) =>
        index > candidate.startLine && isDiagramDeclaration(observation.text),
    })
    if (members.length === 0) {
      logger?.warn(`mermaid 候选在第 ${candidate.startLine} 行，但选区里求不到几何区域，跳过覆盖`)
      continue
    }

    const lines = members.map((index) => observations[index]?.text ?? '')
    // 区域内一条连线行都没有，就没有图可言：渲染站会把裸声明还成一张空图，覆盖上去等于用空白盖住声明行。
    if (!lines.some(hasStructuralLine)) {
      logger?.warn(`mermaid 候选在第 ${candidate.startLine} 行，但几何区域内没有连线行，跳过覆盖`)
      continue
    }

    // 尝试序列：LLM 修复版（译标签 → 原文）排在最前，其后才是每个规则候选的「译标签 → 原文」——
    // 每个版本被渲染站拒了都还有下一层退路，图不能因修复或译文而消失。
    // 全部候选共享一次翻译调用（对照表按主送源建立）。
    const candidateSources = chartSourceCandidates(lines)
    // 链上必经一步：对这张图的全区域规则归一版做恰一次 LLM 修复；不可用只落回规则候选。
    const refined = await refineChartSource(refine, candidateSources[0], logger)
    // 标签对照表改建在修复版上（修复在场时）：主送源决定要译的标签集，规则兜底候选复用同一份表——
    // 其标签若不在表内，mapNodeLabels 保留原文，不坏于现状。
    const ruleSources = candidateSources.map((attempt) => attempt.source)
    const lookup = await chartLabelLookup(refined === null ? ruleSources : [refined, ...ruleSources], translateLabels, logger)
    const attempts: Array<{ source: string; memberIndices: number[]; refined: boolean }> = []
    const pushAttempts = (source: string, memberIndices: number[], isRefined: boolean): void => {
      if (lookup !== null) {
        const mapped = mapNodeLabels(source, (label) => lookup.get(label) ?? null).output
        // 译文版与原文版逐字节相同时不重复送渲染：中文标签经语言门控原文回填后，两条尝试本是
        // 同一份源码，渲染站拒第一条时第二条注定同样失败，白付一次往返还把失败日志搅混。
        if (mapped !== source) {
          attempts.push({ source: mapped, memberIndices, refined: isRefined })
        }
      }
      attempts.push({ source, memberIndices, refined: isRefined })
    }
    if (refined !== null) {
      pushAttempts(refined, candidateSources[0]?.memberIndices ?? [], true)
    }
    for (const attempt of candidateSources) {
      pushAttempts(attempt.source, attempt.memberIndices, false)
    }

    let rendered: MermaidRenderResult | null = null
    // 记下成功那份的源码：节点标签翻译成功时它是译文版源码，与「区域内全部行」不是同一份，
    // 不带出来就得由消费方按自己的行还原，两边比的不是同一份源码。
    let renderedSource: string | undefined
    let renderedByRefine = false
    let failure: unknown = null
    let covered = members
    for (const attempt of attempts) {
      try {
        rendered = await render(attempt.source)
        renderedSource = attempt.source
        renderedByRefine = attempt.refined
        // memberIndices 是 lines 内的下标，按 members 映射回观察下标才是实际覆盖的成员。
        covered = attempt.memberIndices
          .map((index) => members[index])
          .filter((value): value is number => value !== undefined)
        break
      } catch (error) {
        failure = error
      }
    }
    if (rendered === null) {
      logger?.warn(
        `mermaid 渲染失败，跳过该图：${failure instanceof Error ? failure.message : String(failure)}`,
      )
      continue
    }
    // 「规则命中还是 LLM 救回」是可观察性要求：没有这条留痕，修复步骤的效果好坏在诊断里不可分辨。
    logger?.info(`mermaid 图渲染成功：命中来源为${renderedByRefine ? ' LLM 修复版' : '规则候选'}`)
    if (covered.length < members.length) {
      // 裁剪成功说明几何区域把非图内容也框了进来（多半是图后紧跟的正文，空行又被 OCR 丢了）。
      // 这不影响这次覆盖，但它是 OCR 分块的系统性信号，值得留痕而不是悄悄吞掉。
      logger?.info(
        `mermaid 候选在第 ${candidate.startLine} 行：区域末尾 ${members.length - covered.length} 行不是图内容，源码与版位已裁到末条连线行`,
      )
    }
    // 版位由实际覆盖的那几行算：被裁掉的行还留着版位的话，图会撑着一片盖住正文的空白，
    // 而那片空白里的译文也因此被误判为「让位」而不覆盖。covered 至少含锚点（其盒子已通过可用性检查）。
    const box = rectOfMembers(observations, covered)
    if (box === null) {
      continue
    }
    charts.push({ svg: rendered.svg, intrinsic: rendered.intrinsic, box, source: renderedSource })
  }
  return charts
}

export async function composeOverlayPlan(
  blocks: readonly OverlayBlock[],
  region: Rect,
  deps: ComposeOverlayDeps,
): Promise<OverlayPlan> {
  const includeTexts = deps.texts !== false
  const render = deps.render
  const observations: PlacedObservation[] = blocks.map((block) => ({
    text: block.source,
    box: block.box,
  }))
  // 观察逐条以换行拼接即源码文本：一条观察一行，于是候选块的 startLine 就是它在 observations 里的下标，
  // 成为几何扩张的锚点。这个对应关系是 chart-region 的前提，改变拼接方式必须同步改锚点求法。
  const sourceText = observations.map((observation) => observation.text).join('\n')

  // 没有渲染方就没有图可言；此时连检测都不必跑（检测只是为渲染挑料）。
  const charts =
    render === undefined
      ? []
      : await composeCharts(observations, sourceText, region, render, deps)

  // 关闭文本翻译时 blocks 的 translation 是空串（翻译步骤被跳过以省一次外部调用）；
  // 那种空盒不该落到覆盖层上，故整批不产出译文——图表已独立成层，不受影响。
  //
  // 上屏门控：译文与原文相同的块不产译文盒。语言门控让中文条目以原文回填后，这些块若照常装配，
  // 屏幕上会被盖一层 OCR 识别出的同文——原字本来是对的，OCR 的错字（如「崩」认成「跚」）反而
  // 糊在干净的原字上。图表是独立层，中文屏上图照常渲染，不受此门控影响。
  const texts: OverlayTextInput[] = includeTexts
    ? blocks
        .filter((block) => block.translation !== block.source)
        .map((block) => ({ translation: block.translation, box: block.box }))
    : []
  return planOverlay({ texts, charts })
}
