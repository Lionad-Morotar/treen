/**
 * 「只让最新一次触发的结果落地」的闸门。
 *
 * 覆盖注入是整批替换，而它前面挂着耗时不定的异步链路（OCR + 外部翻译 + 渲染站）。用户连着点
 * 两块区域时两条链路并发，先发起的那条完全可能后完成，于是旧选区的译文盖在新选区上，屏幕上
 * 呈现的是点击顺序之外的结果。闸门按发起次序发号，落地前核对号码，过期结果丢弃。
 *
 * 不做串行排队：排队会让第二次点击等第一次跑完（含一次付费的外部调用），延迟全部暴露给用户，
 * 而用户的意图本来就只是「最后点的那块」。
 */
export interface LatestGate {
  /** 取本次触发的号；调用方持有它到落地前。 */
  begin(): number
  /** 该号是否仍是最新一次触发。 */
  isCurrent(token: number): boolean
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
  }
}
