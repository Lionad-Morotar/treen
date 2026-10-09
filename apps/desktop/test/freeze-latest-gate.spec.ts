import { describe, expect, it } from 'vitest'
import { createLatestGate } from '../src/freeze/latest-gate'

describe('createLatestGate：只让最新一次触发的结果落地', () => {
  it('先取的号在第二次触发后即过期', () => {
    const gate = createLatestGate()

    const first = gate.begin()
    expect(gate.isCurrent(first)).toBe(true)

    const second = gate.begin()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
  })

  it('过期判据与落地时机无关：号只在新的 begin 后失效', () => {
    const gate = createLatestGate()
    const token = gate.begin()

    // 中间读多少次都还是最新的。
    expect([gate.isCurrent(token), gate.isCurrent(token)]).toEqual([true, true])

    gate.begin()
    expect(gate.isCurrent(token)).toBe(false)
  })

  it('号是单调递增的，不会与早先的号撞上', () => {
    const gate = createLatestGate()
    const tokens = [gate.begin(), gate.begin(), gate.begin()]

    expect(tokens).toEqual([...tokens].sort((a, b) => a - b))
    expect(new Set(tokens).size).toBe(tokens.length)
    expect(gate.isCurrent(tokens[2] as number)).toBe(true)
  })

  it('invalidate 作废全部在途号', () => {
    const gate = createLatestGate()
    const first = gate.begin()
    const second = gate.begin()

    gate.invalidate()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(false)
  })

  it('invalidate 后新 begin 照常发号，链路可以重新工作', () => {
    const gate = createLatestGate()
    const stale = gate.begin()
    gate.invalidate()

    const fresh = gate.begin()
    expect(gate.isCurrent(stale)).toBe(false)
    expect(gate.isCurrent(fresh)).toBe(true)
  })
})
