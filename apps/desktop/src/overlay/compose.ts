import { detectMermaidBlocks, hasStructuralLine, isDiagramDeclaration } from '../mermaid/detect'
import { collectNodeLabels, mapNodeLabels } from '../mermaid/labels'
import { normalizeMermaid } from '../mermaid/normalize'
import type { MermaidRenderResult } from '../render-site/client'
import { chartRegionMembers, rectOfMembers, type PlacedObservation } from './chart-region'
import { planOverlay, type OverlayChartInput, type OverlayPlan, type OverlayTextInput } from './layout'
import type { Rect } from '../freeze/geometry'

/**
 * 覆盖计划的装配：把翻译链路的产物（带屏幕落点的译文块）拼成渲染层能直接消费的计划。
 *
 * 这里是图表落点的关键决策点，串起三件事：
 * 1. 用 OCR 观察的文字还原源码文本，做 mermaid 候选检测；
 * 2. 对每个候选，以「声明所在观察」为锚点，用几何连续性求出它占住的那几行，并得到矩形；
 * 3. 把那几行归一化后送渲染站拿 SVG，按 contain 适配进那个矩形。
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
  /** 是否产出译文覆盖；缺省 true。关闭时仍照常检测图表（图不需要译文，只需源码文本）。 */
  texts?: boolean
  logger?: { warn(message: string): void; info(message: string): void }
}

/**
 * 一个候选块值得送渲染站的源码，按尝试次序排列；`lineCount` 是它覆盖的行数（供重算版位）。
 *
 * 第一条是几何区域内的全部行。第二条只在「末尾还有非连线行」时才有：图后紧邻正文时（中间的空行
 * 常被 OCR 丢掉），整段注定渲染失败，而图本身是好的——砍掉最后一条连线行之后的行再试一次。
 * 只砍尾部的非连线行，连线行一条不动：按检测层自己的判据，连线行才是图的结构，砍它们才可能得到
 * 与屏幕不符的图。这是**由渲染站裁决**的裁剪，不是对行义的猜测。
 */
function chartSourceCandidates(lines: readonly string[]): Array<{ source: string; lineCount: number }> {
  const candidates = [{ source: normalizeMermaid(lines.join('\n')), lineCount: lines.length }]
  const lastStructural = lines.reduce(
    (last, line, index) => (hasStructuralLine(line) ? index : last),
    -1,
  )
  if (lastStructural >= 0 && lastStructural < lines.length - 1) {
    const kept = lines.slice(0, lastStructural + 1)
    candidates.push({ source: normalizeMermaid(kept.join('\n')), lineCount: kept.length })
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
    // 候选按「全区域 → 砍尾」排列，首个是超集。图后紧跟正文时候选里会混入正文行，
    // 其中的括号文本可能被收进标签集合（白付几个 token），但替换只作用于最终渲染成功的
    // 候选源码，不会把译文写进产物；消除这笔浪费要改标签提取的范围语义，归后续切片。
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
 * 把选区里的 mermaid 候选逐个变成图表版位。渲染方由调用方给定——它缺席时整个函数不会被调用。
 * 每个候选的取舍（几何求区域、区域裁剪源码、渲染站裁决、两种源码尝试）见文件头的说明。
 */
async function composeCharts(
  observations: readonly PlacedObservation[],
  sourceText: string,
  region: Rect,
  render: (source: string) => Promise<MermaidRenderResult>,
  translateLabels: ((labels: readonly string[]) => Promise<string[]>) | undefined,
  logger?: { warn(message: string): void; info(message: string): void },
): Promise<OverlayChartInput[]> {
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

    // 尝试序列：每个候选先试「节点文案已翻译」的版本，渲染站拒了再退回原文版本——
    // 翻译模型返回的内容可能让源码不合法（括号、引号），图不能因译文而消失。
    // 全部候选共享一次翻译调用（对照表按首个候选的超集建立）。
    const candidateSources = chartSourceCandidates(lines)
    const lookup = await chartLabelLookup(candidateSources.map((attempt) => attempt.source), translateLabels, logger)
    const attempts: Array<{ source: string; lineCount: number }> = []
    for (const attempt of candidateSources) {
      if (lookup !== null) {
        attempts.push({
          source: mapNodeLabels(attempt.source, (label) => lookup.get(label) ?? null).output,
          lineCount: attempt.lineCount,
        })
      }
      attempts.push(attempt)
    }

    let rendered: MermaidRenderResult | null = null
    let failure: unknown = null
    let covered = members
    for (const attempt of attempts) {
      try {
        rendered = await render(attempt.source)
        covered = members.slice(0, attempt.lineCount)
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
    charts.push({ svg: rendered.svg, intrinsic: rendered.intrinsic, box })
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
      : await composeCharts(observations, sourceText, region, render, deps.translateLabels, deps.logger)

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
