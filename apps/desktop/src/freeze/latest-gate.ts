/**
 * 「只让最新一次触发的结果落地」的闸门。
 *
 * 覆盖注入与冻结期拷贝都是整批落地，而它们前面挂着耗时不定的异步链路（OCR + 外部翻译 +
 * 渲染站，或读选区 + 写剪贴板）。用户连着点两块区域时两条链路并发，先发起的那条完全可能
 * 后完成，于是旧结果盖在新结果上。闸门按发起次序发号，落地前核对号码，过期结果丢弃。
 *
 * 不做串行排队：排队会让第二次点击等第一次跑完（含一次付费的外部调用），延迟全部暴露给
 * 用户，而用户的意图本来就只是「最后点的那块」。
 */
export interface LatestGate {
  /** 取本次触发的号；调用方持有它到落地前。 */
  begin(): number
  /** 该号是否仍是最新一次触发。 */
  isCurrent(token: number): boolean
  /**
   * 作废当前全部在途号。给「这条链路整体不再落地」的时刻用——冻结退出后，在途的拷贝轮
   * 若不作废，会拿着退出前读到的素材继续写剪贴板，绕过 frozen 守卫。
   *
   * 与 begin 同为前移 generation，但不复用 begin：begin 语义是「新一轮开始」并返回新号，
   * 借它作废会让阅读者困惑返回值给谁用；invalidate 表达的是没有任何新动作、只有废弃。
   */
  invalidate(): void
}

export function createLatestGate(): LatestGate {
  let generation = 0
  return {
    begin() {
      generation += 1
      return generation
    },
    isCurrent(token) {
      return token === generation
    },
    invalidate() {
      generation += 1
    },
  }
}
