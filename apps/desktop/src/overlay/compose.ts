import { detectMermaidBlocks, hasStructuralLine } from '../mermaid/detect'
import { normalizeMermaid } from '../mermaid/normalize'
import type { MermaidRenderResult } from '../render-site/client'
import { chartRegion, chartRegionMembers, rectOfMembers, type PlacedObservation } from './chart-region'
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
 */

/** 翻译链路交出的一段译文：source 为识别到的原文，translation 为译文，box 为其屏幕落点。 */
export interface OverlayBlock {
  source: string
  translation: string
  box: Rect
}

export interface ComposeOverlayDeps {
  /** 送渲染站渲染一段 mermaid 源码；失败抛错 */
  render(source: string): Promise<MermaidRenderResult>
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

export async function composeOverlayPlan(
  blocks: readonly OverlayBlock[],
  region: Rect,
  deps: ComposeOverlayDeps,
): Promise<OverlayPlan> {
  const observations: PlacedObservation[] = blocks.map((block) => ({
    text: block.source,
    box: block.box,
  }))
  // 观察逐条以换行拼接即源码文本：一条观察一行，于是候选块的 startLine 就是它在 observations 里的下标，
  // 成为几何扩张的锚点。这个对应关系是 chart-region 的前提，改变拼接方式必须同步改锚点求法。
  const sourceText = observations.map((observation) => observation.text).join('\n')

  const charts: OverlayChartInput[] = []
  for (const candidate of detectMermaidBlocks(sourceText)) {
    const box = chartRegion(observations, candidate.startLine, { bound: region })
    if (box === null) {
      deps.logger?.warn(`mermaid 候选在第 ${candidate.startLine} 行，但选区里求不到几何区域，跳过覆盖`)
      continue
    }

    const members = chartRegionMembers(observations, candidate.startLine, { bound: region })
    const lines = members.map((index) => observations[index]?.text ?? '')
    // 区域内一条连线行都没有，就没有图可言：渲染站会把裸声明还成一张空图，覆盖上去等于用空白盖住声明行。
    if (!lines.some(hasStructuralLine)) {
      deps.logger?.warn(`mermaid 候选在第 ${candidate.startLine} 行，但几何区域内没有连线行，跳过覆盖`)
      continue
    }

    let rendered: MermaidRenderResult | null = null
    let failure: unknown = null
    let covered = members
    for (const attempt of chartSourceCandidates(lines)) {
      try {
        rendered = await deps.render(attempt.source)
        covered = members.slice(0, attempt.lineCount)
        break
      } catch (error) {
        failure = error
      }
    }
    if (rendered === null) {
      deps.logger?.warn(
        `mermaid 渲染失败，跳过该图：${failure instanceof Error ? failure.message : String(failure)}`,
      )
      continue
    }
    if (covered.length < members.length) {
      // 裁剪成功说明几何区域把非图内容也框了进来（多半是图后紧跟的正文，空行又被 OCR 丢了）。
      // 这不影响这次覆盖，但它是 OCR 分块的系统性信号，值得留痕而不是悄悄吞掉。
      deps.logger?.info(
        `mermaid 候选在第 ${candidate.startLine} 行：区域末尾 ${members.length - covered.length} 行不是图内容，源码与版位已裁到末条连线行`,
      )
    }
    // 源码被裁过时，版位随之收到那几行：被裁掉的行还留着版位的话，图会撑着一片盖住正文的空白，
    // 而那片空白里的译文也因此被误判为「让位」而不覆盖。
    const finalBox = rectOfMembers(observations, covered) ?? box
    charts.push({ svg: rendered.svg, intrinsic: rendered.intrinsic, box: finalBox })
  }

  const texts: OverlayTextInput[] = blocks.map((block) => ({
    translation: block.translation,
    box: block.box,
  }))
  return planOverlay({ texts, charts })
}
