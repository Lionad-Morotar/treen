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

/** 假助手进程：记录 stdin 写入，允许测试手动喂 stdout 行与 exit/error 事件。 */
interface FakeProcessHarness {
  proc: CaptureProcessLike
  emitLine(line: string): void
  emitExit(code: number | null): void
  emitError(error: Error): void
  written(): string[]
  stdinEnded(): boolean
  kill: ReturnType<typeof vi.fn>
}

function createFakeProcess(): FakeProcessHarness {
  const dataListeners: Array<(chunk: Buffer) => void> = []
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
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
        if (event === 'exit') {
          exitListeners.push(listener)
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
    emitExit(code: number | null) {
      for (const listener of [...exitListeners]) {
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
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('parseAccelerator', () => {
  it('expands CommandOrControl on darwin and keeps other modifiers', () => {
    const parsed = parseAccelerator('CommandOrControl+Shift+X')
    expect(parsed).toEqual({
      accel: 'CommandOrControl+Shift+X',
      mods: { cmd: true, shift: true, ctrl: false, opt: false },
      key: 'x',
    })
  })

  it('rejects keys the tap cannot match by character', () => {
    expect(parseAccelerator('Escape')).toBeNull()
    expect(parseAccelerator('CommandOrControl+F1')).toBeNull()
    expect(parseAccelerator('CommandOrControl+Space')).toBeNull()
  })

  it('rejects unknown modifiers and empty input', () => {
    expect(parseAccelerator('Hyper+X')).toBeNull()
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
    expect(channel).not.toBeNull()
    expect((channel as HotkeyCaptureChannel).available()).toBe(true)
    expect((channel as HotkeyCaptureChannel).status()).toEqual({ active: true, authorized: true })
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
    ;(channel as HotkeyCaptureChannel).dispose()
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
      spawn: spawn as unknown as never,
    })
    expect(channel).toBeNull()
  })

  it('forwards HIT lines to the onHit handler', async () => {
    const harness = createSpawnHarness()
    const channelPromise = spawnHotkeyCaptureChannel({
      helperPath: '/bin/hotkey-capture',
      hotkeys: ['CommandOrControl+Shift+X'],
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('READY')
    const channel = (await channelPromise) as HotkeyCaptureChannel
    const onHit = vi.fn()
    channel.onHit(onHit)
    harness.latest().emitLine('HIT CommandOrControl+Shift+X')
    expect(onHit).toHaveBeenCalledWith('CommandOrControl+Shift+X')
    channel.dispose()
  })

  it('pushes hotkey table updates through stdin and filters unsupported keys', async () => {
    const harness = createSpawnHarness()
    const channelPromise = spawnHotkeyCaptureChannel({
      helperPath: '/bin/hotkey-capture',
      hotkeys: [],
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('READY')
    const channel = (await channelPromise) as HotkeyCaptureChannel
    channel.setHotkeys(['CommandOrControl+Shift+X', 'Escape'])
    const frames = harness.latest().written()
    expect(frames).toHaveLength(1)
    const payload = JSON.parse(frames[0] ?? '{}')
    // Escape 无法按字符命中，通道侧直接过滤，助手永远收不到它。
    expect(payload.hotkeys).toHaveLength(1)
    expect(payload.hotkeys[0].key).toBe('x')
    channel.dispose()
  })

  it('respawns after a crash and replays the hotkey table', async () => {
    const harness = createSpawnHarness()
    const channelPromise = spawnHotkeyCaptureChannel({
      helperPath: '/bin/hotkey-capture',
      hotkeys: ['CommandOrControl+Shift+X'],
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('READY')
    const channel = (await channelPromise) as HotkeyCaptureChannel
    channel.setHotkeys(['CommandOrControl+Shift+C'])

    harness.latest().emitExit(1)
    expect(channel.available()).toBe(false)
    await vi.advanceTimersByTimeAsync(600)
    expect(harness.spawn).toHaveBeenCalledTimes(2)
    harness.latest().emitLine('READY')
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.available()).toBe(true)
    // 重启后重放最新键表（含运行中改过的 C），不是启动时的旧表。
    const replay = JSON.parse(harness.latest().written()[0] ?? '{}')
    expect(replay.hotkeys[0].key).toBe('c')
    channel.dispose()
  })

  it('reports unavailable when the respawned helper fails to boot', async () => {
    const harness = createSpawnHarness()
    const channelPromise = spawnHotkeyCaptureChannel({
      helperPath: '/bin/hotkey-capture',
      hotkeys: ['CommandOrControl+Shift+X'],
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('READY')
    const channel = (await channelPromise) as HotkeyCaptureChannel
    const onUnavailable = vi.fn()
    channel.onUnavailable(onUnavailable)

    harness.latest().emitExit(1)
    await vi.advanceTimersByTimeAsync(600)
    harness.latest().emitLine('TAP-ERROR permission-denied')
    await vi.advanceTimersByTimeAsync(0)

    expect(onUnavailable).toHaveBeenCalledTimes(1)
    expect(channel.available()).toBe(false)
    expect(channel.status()).toEqual({ active: false, authorized: true })
    channel.dispose()
  })

  it('disposes the assistant: stdin closed, killed, no further activity', async () => {
    const harness = createSpawnHarness()
    const channelPromise = spawnHotkeyCaptureChannel({
      helperPath: '/bin/hotkey-capture',
      hotkeys: ['CommandOrControl+Shift+X'],
      spawn: harness.spawn as unknown as SpawnLike,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('READY')
    const channel = (await channelPromise) as HotkeyCaptureChannel

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
      spawn: harness.spawn as unknown as never,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitLine('PERMISSION ok')
    await expect(pending).resolves.toBe(true)
    expect(harness.spawn).toHaveBeenCalledWith('/bin/hotkey-capture', ['--probe'])
  })

  it('resolves null when the probe exits without reporting', async () => {
    const harness = createSpawnHarness()
    const pending = probeHotkeyCapturePermission({
      helperPath: '/bin/hotkey-capture',
      spawn: harness.spawn as unknown as never,
    })
    await vi.advanceTimersByTimeAsync(0)
    harness.latest().emitExit(1)
    await expect(pending).resolves.toBeNull()
  })
})
