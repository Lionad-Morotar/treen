import { describe, expect, it } from 'vitest'
import { devPageEnabled, isDevPagePath, withoutDevPages } from '../app/utils/dev-pages'

/**
 * dev 页面摘除判定的单测。
 *
 * 判定必须是可单测的纯函数而不是埋进 `nuxt.config.ts` 的闭包里：生产的 `pages:extend` 与 dev
 * 的分支在源码里是同一段，靠改 `isDev` 入参才能覆盖两侧；留在配置里就只有「实跑一次生产构建」
 * 这一条验证路径，而那条路径一旦通过就不再有人回头看它。
 */

describe('dev 页面路径的识别', () => {
  it('/dev 与其子路径都算 dev 页面', () => {
    expect(isDevPagePath('/dev')).toBe(true)
    expect(isDevPagePath('/dev/pipeline')).toBe(true)
    expect(isDevPagePath('/dev/pipeline/extra')).toBe(true)
  })

  it('只是前缀撞上的路径不算 dev 页面', () => {
    expect(isDevPagePath('/')).toBe(false)
    expect(isDevPagePath('/device')).toBe(false)
    expect(isDevPagePath('/dev-pipeline')).toBe(false)
  })
})

describe('dev 页面的摘除', () => {
  const PAGES = [
    { path: '/' },
    { path: '/dev/pipeline' },
    { path: '/other' },
  ]

  it('dev 环境整份路由表原样保留', () => {
    expect(withoutDevPages(PAGES, true)).toEqual(PAGES)
  })

  it('非 dev 环境摘掉 /dev 下的页面，其余页面一个不动', () => {
    expect(withoutDevPages(PAGES, false)).toEqual([{ path: '/' }, { path: '/other' }])
  })

  it('摘除不改动传入的数组：pages:extend 的入参是 Nuxt 自己的数组，就地改会连累注册的其它钩子', () => {
    const pages = [...PAGES]
    const kept = withoutDevPages(pages, false)
    expect(kept).not.toBe(pages)
    expect(pages).toEqual(PAGES)
  })

  it('带子路由的 dev 页面整棵摘掉', () => {
    const pages = [
      { path: '/dev', children: [{ path: 'pipeline' }, { path: 'other' }] },
      { path: '/', children: [{ path: 'a' }] },
    ]

    expect(withoutDevPages(pages, false)).toEqual([{ path: '/', children: [{ path: 'a' }] }])
    expect(withoutDevPages(pages, true)[0]?.children).toHaveLength(2)
  })

  it('路由表里没有 dev 页面时两侧结果一致', () => {
    const pages = [{ path: '/' }]
    expect(withoutDevPages(pages, false)).toEqual(pages)
    expect(withoutDevPages(pages, true)).toEqual(pages)
  })
})

/**
 * 运行期这道防线的判据。
 *
 * 摘路由是构建期的事，判定依赖一次环境取值，失准时页面代码照样进产物；页面侧这一道是最后
 * 兜底，故它自己的判据必须单独立得住，而不是和摘除判定共用一句表达式。
 */
describe('dev 页面的运行期兜底', () => {
  it('只有 dev 为真才露出调试内容', () => {
    expect(devPageEnabled(true)).toBe(true)
    expect(devPageEnabled(false)).toBe(false)
  })

  it('打包器没替换 import.meta.dev 时按不可用处理，不猜默认值', () => {
    expect(devPageEnabled(undefined)).toBe(false)
  })
})
