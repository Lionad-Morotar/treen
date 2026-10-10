import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCaptureLineParser,
  parseAccelerator,
  probeHotkeyCapturePermission,
  spawnHotkeyCaptureChannel,
  type CaptureProcessLike,
  type HotkeyCaptureChannel,
  type SpawnLike,
} from '../src/freeze/hotkey-capture'

/** 假助手进程：记录 stdin 写入，允许测试手动喂 stdout 行与 close/error 事件。 */
interface FakeProcessHarness {
  proc: CaptureProcessLike
  emitLine(line: string): void
  emitClose(code: number | null): void
  emitError(error: Error): void
  written(): string[]
  stdinEnded(): boolean
  kill: ReturnType<typeof vi.fn>
}

function createFakeProcess(): FakeProcessHarness {
  const dataListeners: Array<(chunk: Buffer) => void> = []
  const closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const errorListeners: Array<(error: Error) => void> = []
  const chunks: string[] = []
  let ended = false
  const kill = vi.fn(() => true)
  return {
    proc: {
      pid: 4242,
      stdin: {
        write: (chunk: string) => {
          chunks.push(chunk)
          return true
        },
        end: () => {
          ended = true
        },
      },
      stdout: {
        on: (_event, listener) => {
          dataListeners.push(listener)
        },
      },
      stderr: { on: () => {} },
      kill,
      on: (event: string, listener: never) => {
        if (event === 'close') {
          closeListeners.push(listener)
        }
        if (event === 'error') {
          errorListeners.push(listener)
        }
        return undefined
      },
    },
    emitLine(line: string) {
      for (const listener of dataListeners) {
        listener(Buffer.from(`${line}\n`))
      }
    },
    emitClose(code: number | null) {
      for (const listener of [...closeListeners]) {
        listener(code, null)
      }
    },
    emitError(error: Error) {
      for (const listener of [...errorListeners]) {
        listener(error)
      }
    },
    written: () => chunks,
    stdinEnded: () => ended,
    kill,
  }
}

interface SpawnHarness {
  spawn: ReturnType<typeof vi.fn>
  latest(): FakeProcessHarness
  count(): number
}

function createSpawnHarness(): SpawnHarness {
  const processes: FakeProcessHarness[] = []
  const spawn = vi.fn(() => {
    const fake = createFakeProcess()
    processes.push(fake)
    return fake.proc as CaptureProcessLike
  })
  return {
    spawn: spawn as unknown as ReturnType<typeof vi.fn>,
    latest: () => {
      const last = processes[processes.length - 1]
      if (last === undefined) {
        throw new Error('spawn 未被调用')
      }
      return last
    },
    count: () => processes.length,
  }
}

/** 快速建一个在岗通道：spawn 假进程并喂 READY。 */
async function spawnReadyChannel(harness: SpawnHarness, hotkeys: readonly string[]): Promise<HotkeyCaptureChannel> {
  const pending = spawnHotkeyCaptureChannel({
    helperPath: '/bin/hotkey-capture',
    hotkeys,
    spawn: harness.spawn as unknown as SpawnLike,
  })
  await vi.advanceTimersByTimeAsync(0)
  harness.latest().emitLine('READY')
  const channel = await pending
  if (channel === null) {
    throw new Error('通道应建立成功')
  }
  return channel
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('parseAccelerator', () => {
  it('accepts Command-based combos and expands modifiers', () => {
    expect(parseAccelerator('CommandOrControl+Shift+X')).toEqual({
      accel: 'CommandOrControl+Shift+X',
      mods: { cmd: true, ctrl: false, opt: false, shift: true },
      key: 'x',
    })
    expect(parseAccelerator('Cmd+C')?.key).toBe('c')
    expect(parseAccelerator('Meta+X')?.mods.cmd).toBe(true)
    expect(parseAccelerator('Super+X')?.mods.cmd).toBe(true)
  })

  it('rejects combos the tap cannot match by character, falling back to global', () => {
    // Option/Control 参与布局字符合成（Option+X → ≈、Control+X → 控制符），tap 永不命中。
    expect(parseAccelerator('Alt+T')).toBeNull()
    expect(parseAccelerator('Option+T')).toBeNull()
    expect(parseAccelerator('Control+X')).toBeNull()
    // 纯 Shift/裸字符会吞掉正常打字；功能键无字符可判。
    expect(parseAccelerator('Shift+X')).toBeNull()
    expect(parseAccelerator('X')).toBeNull()
    expect(parseAccelerator('Escape')).toBeNull()
    expect(parseAccelerator('CommandOrControl+F1')).toBeNull()
    expect(parseAccelerator('CommandOrControl+Space')).toBeNull()
  })

  it('rejects unknown modifiers, control characters and empty input', () => {
    expect(parseAccelerator('Hyper+X')).toBeNull()
    expect(parseAccelerator('Command+Shift+\nX')).toBeNull()
    expect(parseAccelerator('')).toBeNull()
    expect(parseAccelerator('+')).toBeNull()
  })
})

describe('createCaptureLineParser', () => {
  it('parses hit lines into the handler', () => {
    const onHit = vi.fn()
    const parser = createCaptureLineParser({ onHit })
    parser('HIT CommandOrControl+Shift+X')
    expect(onHit).toHaveBeenCalledWith('CommandOrControl+Shift+X')
  })

  it('ignores malformed and unknown lines without breaking the stream', () => {
    const onHit = vi.fn()
    const onReady = vi.fn()
    const parser = createCaptureLineParser({ onHit, onReady })
    expect(() => {
      parser('HIT ')
      parser('随机乱码输出')
      parser('HITX without space')
      parser('')
    }).not.toThrow()
    expect(onHit).not.toHaveBeenCalled()
    parser('READY')
    expect(onReady).toHaveBeenCalledTimes(1)
  })

  it('maps permission and tap error lines', () => {
    const events = { onPermission: vi.fn(), onTapError: vi.fn() }
    const parser = createCaptureLineParser(events)
    parser('PERMISSION ok')
    parser('PERMISSION denied')
    parser('TAP-ERROR permission-denied')
    expect(events.onPermission).toHaveBeenNthCalledWith(1, true)
    expect(events.onPermission).toHaveBeenNthCalledWith(2, false)
    expect(events.onTapError).toHaveBeenCalledWith('permission-denied')
  })
})

describe('spawnHotkeyCaptureChannel', () => {
  it('resolves a channel once the assistant reports READY', async () => {
    const harness = createSpawnHarness()
    const pending = spawnHotkeyCaptureChannel({
      helperPath: '/bin/hotkey-capture',
      hotkeys: ['CommandOrControl+Shift+X'],
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('READY')
    const channel = await pending
    if (channel === null) {
      throw new Error('通道应建立成功')
    }
    expect(channel.available()).toBe(true)
    expect(channel.status()).toEqual({ ready: true, active: true, authorized: true, reason: null })
    // 初始键表经启动参数传入：spawn args 里应带完整条目 JSON。
    const args = harness.spawn.mock.calls[0]?.[1] as string[]
    expect(args[0]).toBe('--hotkeys')
    expect(JSON.parse(args[1] ?? '{}')).toEqual({
      hotkeys: [
        {
          accel: 'CommandOrControl+Shift+X',
          mods: { cmd: true, shift: true, ctrl: false, opt: false },
          key: 'x',
        },
      ],
    })
    channel.dispose()
  })

  it('returns null on permission denial and kills the assistant', async () => {
    const harness = createSpawnHarness()
    const channelPromise = spawnHotkeyCaptureChannel({
      helperPath: '/bin/hotkey-capture',
      hotkeys: [],
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('TAP-ERROR permission-denied')
    const channel = await channelPromise
    expect(channel).toBeNull()
    expect(harness.latest().kill).toHaveBeenCalled()
  })

  it('returns null when the helper never reports READY, killing it on timeout', async () => {
    const harness = createSpawnHarness()
    const channelPromise = spawnHotkeyCaptureChannel({
      helperPath: '/bin/hotkey-capture',
      hotkeys: [],
      spawn: harness.spawn as unknown as SpawnLike,
      timeoutMs: 1000,
    })
    await vi.advanceTimersByTimeAsync(1000)
    const channel = await channelPromise
    expect(channel).toBeNull()
    expect(harness.latest().kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('returns null when spawn itself fails (missing binary)', async () => {
    const spawn = vi.fn(() => {
      throw new Error('ENOENT')
    })
    const channel = await spawnHotkeyCaptureChannel({
      helperPath: '/missing/hotkey-capture',
      hotkeys: [],
      spawn: spawn as unknown as SpawnLike,
    })
    expect(channel).toBeNull()
  })

  it('forwards HIT lines to the onHit handler', async () => {
    const harness = createSpawnHarness()
    const channel = await spawnReadyChannel(harness, ['CommandOrControl+Shift+X'])
    const onHit = vi.fn()
    channel.onHit(onHit)
    harness.latest().emitLine('HIT CommandOrControl+Shift+X')
    expect(onHit).toHaveBeenCalledWith('CommandOrControl+Shift+X')
    channel.dispose()
  })

  it('pushes hotkey table updates through stdin and filters unsupported keys', async () => {
    const harness = createSpawnHarness()
    const channel = await spawnReadyChannel(harness, [])
    channel.setHotkeys(['CommandOrControl+Shift+X', 'Escape', 'Alt+T'])
    const frames = harness.latest().written()
    expect(frames).toHaveLength(1)
    const payload = JSON.parse(frames[0] ?? '{}')
    // Escape 与 Alt 组合无法按注册字符命中，通道侧直接过滤，助手永远收不到它们。
    expect(payload.hotkeys).toHaveLength(1)
    expect(payload.hotkeys[0].key).toBe('x')
    channel.dispose()
  })

  it('announces unavailable immediately on crash, migrates back on recovery', async () => {
    const harness = createSpawnHarness()
    const channel = await spawnReadyChannel(harness, ['CommandOrControl+Shift+X'])
    const onUnavailable = vi.fn()
    const onRecovered = vi.fn()
    channel.onUnavailable(onUnavailable)
    channel.onRecovered(onRecovered)
    channel.setHotkeys(['CommandOrControl+Shift+C'])

    // 崩溃瞬间即降级（键位可立刻迁回 global），不等重启结果。
    harness.latest().emitClose(1)
    expect(onUnavailable).toHaveBeenCalledTimes(1)
    expect(channel.available()).toBe(false)
    expect(channel.status().active).toBe(false)

    await vi.advanceTimersByTimeAsync(600)
    expect(harness.spawn).toHaveBeenCalledTimes(2)
    harness.latest().emitLine('READY')
    await vi.advanceTimersByTimeAsync(0)
    expect(onRecovered).toHaveBeenCalledTimes(1)
    expect(channel.available()).toBe(true)
    expect(channel.status()).toEqual({ ready: true, active: true, authorized: true, reason: null })
    // 重启后重放最新键表（含运行中改过的 C），不是启动时的旧表。
    const replay = JSON.parse(harness.latest().written()[0] ?? '{}')
    expect(replay.hotkeys[0].key).toBe('c')
    channel.dispose()
  })

  it('reports permission loss after respawn fails with permission-denied', async () => {
    const harness = createSpawnHarness()
    const channel = await spawnReadyChannel(harness, ['CommandOrControl+Shift+X'])
    const onUnavailable = vi.fn()
    channel.onUnavailable(onUnavailable)

    harness.latest().emitClose(1)
    await vi.advanceTimersByTimeAsync(600)
    harness.latest().emitLine('TAP-ERROR permission-denied')
    await vi.advanceTimersByTimeAsync(0)

    expect(onUnavailable).toHaveBeenCalledTimes(1)
    expect(channel.available()).toBe(false)
    // 权限类失败让 authorized 翻 false：设置页据此给出「去授权」入口。
    expect(channel.status()).toEqual({
      ready: true,
      active: false,
      authorized: false,
      reason: 'permission-denied',
    })
    channel.dispose()
  })

  it('stops respawning after the crash budget is exhausted', async () => {
    const harness = createSpawnHarness()
    const channel = await spawnReadyChannel(harness, ['CommandOrControl+Shift+X'])

    // 预算窗口内第 4 次崩溃不再触发重启（初始 1 + 重启 3）。
    for (let round = 0; round < 4; round += 1) {
      harness.latest().emitClose(1)
      await vi.advanceTimersByTimeAsync(600)
      if (harness.count() > round + 1) {
        harness.latest().emitLine('READY')
        await vi.advanceTimersByTimeAsync(0)
      }
    }
    const spawnCalls = harness.count()
    harness.latest().emitClose(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(harness.count()).toBe(spawnCalls)
    expect(channel.available()).toBe(false)
    channel.dispose()
  })

  it('kills the in-flight respawned helper when dispose happens before READY', async () => {
    const harness = createSpawnHarness()
    const channel = await spawnReadyChannel(harness, ['CommandOrControl+Shift+X'])

    harness.latest().emitClose(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(harness.count()).toBe(2)
    // 新进程 READY 之前退出应用：dispose 必须把这个尚无引用的在途进程一起收掉，
    // 否则它会永久持有吞键 tap 而无人能及。
    channel.dispose()
    const inFlight = harness.latest()
    expect(inFlight.stdinEnded()).toBe(true)
    expect(inFlight.kill).toHaveBeenCalledWith('SIGTERM')
    // 收口后新进程再报 READY 不得恢复通道。
    inFlight.emitLine('READY')
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.available()).toBe(false)
  })

  it('disposes the assistant: stdin closed, killed, no further activity', async () => {
    const harness = createSpawnHarness()
    const channel = await spawnReadyChannel(harness, ['CommandOrControl+Shift+X'])

    channel.dispose()
    expect(harness.latest().stdinEnded()).toBe(true)
    expect(harness.latest().kill).toHaveBeenCalledWith('SIGTERM')
    // dispose 后的键表更新是 no-op，不往已关闭的 stdin 写。
    channel.setHotkeys(['CommandOrControl+C'])
    expect(harness.latest().written()).toHaveLength(0)
    // 重复 dispose 幂等。
    expect(() => channel.dispose()).not.toThrow()
  })
})

describe('probeHotkeyCapturePermission', () => {
  it('maps PERMISSION lines to the boolean result', async () => {
    const harness = createSpawnHarness()
    const pending = probeHotkeyCapturePermission({
      helperPath: '/bin/hotkey-capture',
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('PERMISSION ok')
    await expect(pending).resolves.toBe(true)
    expect(harness.spawn).toHaveBeenCalledWith('/bin/hotkey-capture', ['--probe'])
  })

  it('resolves null only when the process closes without reporting', async () => {
    const harness = createSpawnHarness()
    const pending = probeHotkeyCapturePermission({
      helperPath: '/bin/hotkey-capture',
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    // close（stdio 全关）才判失败：短命进程的 exit 可先于管道数据送达，
    // close 后仍到达的 PERMISSION 行应先被解析（这里按正常时序 data 先到）。
    harness.latest().emitLine('PERMISSION denied')
    await expect(pending).resolves.toBe(false)
  })

  it('resolves null when the probe closes without output', async () => {
    const harness = createSpawnHarness()
    const pending = probeHotkeyCapturePermission({
      helperPath: '/bin/hotkey-capture',
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitClose(1)
    await expect(pending).resolves.toBeNull()
  })
})
