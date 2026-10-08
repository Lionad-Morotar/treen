import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FREEZE_ACCELERATOR,
  FREEZE_EXIT_ACCELERATOR,
  freezeWindowOptions,
} from '../src/freeze/window-options'
import type { DisplayLike } from '../src/freeze/geometry'

const display: DisplayLike = {
  id: 3,
  scaleFactor: 1,
  bounds: { x: -1920, y: 120, width: 1920, height: 1080 },
}

describe('freezeWindowOptions', () => {
  it('anchors the window to the display bounds', () => {
    const options = freezeWindowOptions(display)
    expect(options.x).toBe(-1920)
    expect(options.y).toBe(120)
    expect(options.width).toBe(1920)
    expect(options.height).toBe(1080)
  })

  it('builds a frameless transparent always-on-top overlay', () => {
    const options = freezeWindowOptions(display)
    expect(options.transparent).toBe(true)
    expect(options.frame).toBe(false)
    expect(options.alwaysOnTop).toBe(true)
    expect(options.skipTaskbar).toBe(true)
    expect(options.hasShadow).toBe(false)
    expect(options.backgroundColor).toBe('#00000000')
  })

  it('keeps the window static and non-interactive at the OS chrome level', () => {
    const options = freezeWindowOptions(display)
    expect(options.movable).toBe(false)
    expect(options.resizable).toBe(false)
    expect(options.minimizable).toBe(false)
    expect(options.maximizable).toBe(false)
    expect(options.fullscreenable).toBe(false)
  })

  it('starts hidden until the frozen frame is painted', () => {
    expect(freezeWindowOptions(display).show).toBe(false)
  })

  it('accepts the first mouse click so selection clicks are never swallowed by focus', () => {
    expect(freezeWindowOptions(display).acceptFirstMouse).toBe(true)
  })

  it('can grow larger than the screen for full-display coverage on macOS', () => {
    expect(freezeWindowOptions(display).enableLargerThanScreen).toBe(true)
  })

  it('isolates the renderer from Node by default', () => {
    const options = freezeWindowOptions(display)
    expect(options.webPreferences?.contextIsolation).toBe(true)
    expect(options.webPreferences?.nodeIntegration).toBe(false)
  })
})

describe('freeze accelerators', () => {
  it('exposes a configurable trigger accelerator', () => {
    expect(DEFAULT_FREEZE_ACCELERATOR).toBe('CommandOrControl+Shift+X')
  })

  it('exits on Escape', () => {
    expect(FREEZE_EXIT_ACCELERATOR).toBe('Escape')
  })
})
