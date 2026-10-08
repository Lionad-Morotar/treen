import { describe, expect, it } from 'vitest'
import { renderSiteHealth } from '../app/utils/health'

describe('render-site smoke', () => {
  it('reports a healthy render-site payload', () => {
    expect(renderSiteHealth('0.0.0')).toEqual({
      ok: true,
      service: 'treen-render-site',
      version: '0.0.0',
    })
  })
})
