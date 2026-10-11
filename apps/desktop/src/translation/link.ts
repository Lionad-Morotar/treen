import { pickCopyTarget, pickTargetForDisplay } from '../selection'
import { createOcrReader, type OcrBlock, type OcrEngine } from '@treen/shared/translation'
import type { FreezeLogger, SelectionSource } from '../freeze/controller'
import type { Point, Rect } from '../freeze/geometry'

/**
 * 翻译链路的装配：锁定选区 → OCR 取字 → 批量翻译 → 带回屏幕坐标的译文块。
 *
 * 这是 S8 覆盖渲染要消费的形状：每段译文带着它在屏幕上的落点（box），渲染层据此绝对定位。
 * 识别与翻译都经注入（真实实现在 mac-ocr.ts / deepseek-client.ts），故本模块不碰运行时，
 * 可在纯 Node 下被单测与真链路覆盖。
 */

/** 一段译文：source 是识别到的原文，translation 是译文，box 是它在屏幕上的落点（显示器相对 DIP）。 */
export interface TranslatedBlock {
  source: string
  translation: string
  box: Rect
}

export type TranslateOutcome =
  | { kind: 'translated'; displayId: number; region: Rect; blocks: TranslatedBlock[] }
  | { kind: 'skipped'; reason: 'no-window' | 'no-lock' | 'no-text' }

export interface TranslateSelectionDeps {
  /** 收集各屏当前的选区素材（同拷贝的读取口） */
  readSources(): Promise<readonly SelectionSource[]>
  recognize: OcrEngine
  translate(texts: readonly string[]): Promise<string[]>
  pointer?(): Point
  logger?: FreezeLogger
}

/**
 * 生成「翻译当前锁定选区」的动作。
 *
 * 目标选区经 pickCopyTarget 与拷贝同源，但要求确为锁定选区：翻译整屏既非用户意图，
 * 又会把无关文字一并送去翻译与计费。无锁定即跳过，交给调用方决定是否提示。
 *
 * 可选传入 displayId 指定在哪块屏触发：锁定轮询在触发时就已知是哪块屏，不能再退化到
 * 「光标在哪译哪」（多屏各有锁定时那是错的屏）。不传则维持按光标推断的旧语义。
 */
export interface TranslateSelectionOptions {
  /**
   * 是否真的翻译（默认 true）。关闭时跳过外部翻译调用但照做 OCR——图表覆盖只需要识别出的
   * 源码行与屏幕落点，不需要译文，省下一次按次计费的外部调用。
   * 关闭时产出的块 translation 为空串；覆盖计划侧不应把这种空块当译文渲染（见 compose 的 texts 开关）。
   */
  translateText?: boolean
}

export function createTranslateSelection(deps: TranslateSelectionDeps) {
  const readOcr = createOcrReader({ recognize: deps.recognize })

  return async (displayId?: number, options: TranslateSelectionOptions = {}): Promise<TranslateOutcome> => {
    const sources = await deps.readSources()
    const target =
      displayId === undefined
        ? pickCopyTarget(sources, deps.pointer?.())
        : pickTargetForDisplay(sources, displayId)
    if (target === null) {
      deps.logger?.warn('翻译跳过：冻结态没有可用的覆盖窗')
      return { kind: 'skipped', reason: 'no-window' }
    }
    if (!target.fromLock) {
      deps.logger?.warn('翻译跳过：尚未锁定任何候选区域')
      return { kind: 'skipped', reason: 'no-lock' }
    }

    const { source, region } = target
    const blocks: OcrBlock[] = await readOcr(source.frame, region, source.display)
    if (blocks.length === 0) {
      deps.logger?.info(`显示器 ${source.display.id} 的选区未识别到文字`)
      return { kind: 'skipped', reason: 'no-text' }
    }

    const texts = blocks.map((block) => block.text)
    const translateText = options.translateText !== false
    const translations = translateText ? await deps.translate(texts) : texts.map(() => '')
    if (translations.length !== texts.length) {
      // 翻译实现已保证等长（长度失配会在其内部降级逐条）；到这里仍不等即为注入实现违约，
      // 宁可抛错让上层看见，也不交出与原文错位的译文。
      throw new Error(`译文条数 ${translations.length} 与原文 ${texts.length} 不一致`)
    }

    deps.logger?.info(
      translateText
        ? `显示器 ${source.display.id} 选区翻译完成：${blocks.length} 段`
        : `显示器 ${source.display.id} 选区已识别 ${blocks.length} 段（文本翻译已关闭，仅取源码供图表使用）`,
    )
    return {
      kind: 'translated',
      displayId: source.display.id,
      region,
      blocks: blocks.map((block, index) => ({
        source: block.text,
        translation: translations[index] as string,
        box: block.box,
      })),
    }
  }
}
