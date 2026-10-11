import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DevRouteError } from '../server/utils/dev-gate'
import { listSamples, readSample, zRefsRoot } from '../server/utils/dev-samples'

const created: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'treen-samples-'))
  created.push(root)
  return root
}

afterEach(() => {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** 内容即 btoa 期望值，便于按独立算出的字面量断言 base64 而非按实现反算。 */
const TREEN_TEXT = 'treen-sample'
const TREEN_BASE64 = 'dHJlZW4tc2FtcGxl'

function write(root: string, relative: string): void {
  const target = join(root, relative)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, TREEN_TEXT)
}

describe('样本库目录列举', () => {
  /**
   * 空态而非报错是页面的硬要求：zRefs 被gitignore排除在仓外，换机器/拉干净仓时
   * 目录缺属常态，下拉要能用空态文案承接而不是甩一个异常面板。
   */
  it('目录不存在时给空列表与空 root，不抛错', () => {
    expect(listSamples({ root: join(makeRoot(), 'nope') })).toEqual({ root: null, samples: [] })
  })

  it('目录为空时给空列表但保留 root，供页面区分「没有」与「不在」', () => {
    const root = makeRoot()
    expect(listSamples({ root })).toEqual({ root, samples: [] })
  })

  it('递归收图，只收 OCR 认得的格式，并按名字排稳定序', () => {
    const root = makeRoot()
    write(root, 'top.png')
    write(root, 'notes.txt')
    write(root, 'sketch.webp')
    write(root, 'bug-261010/orig.png')

    expect(listSamples({ root }).samples).toEqual([
      { name: 'bug-261010/orig.png', size: TREEN_TEXT.length },
      { name: 'top.png', size: TREEN_TEXT.length },
    ])
  })

  it('递归有深度上限：三层以下的图不进列表，免得整仓都被展开', () => {
    const root = makeRoot()
    write(root, 'a/too/deep.png')

    expect(listSamples({ root }).samples).toEqual([])
  })

  it('不跟随符号链接：存在自引用目录时也不会把链路拖死或吐出链外内容', () => {
    const root = makeRoot()
    write(root, 'top.png')
    symlinkSync('..', join(root, 'loop'))

    const names = listSamples({ root }).samples.map((sample) => sample.name)

    expect(names).toEqual(['top.png'])
  })
})

describe('样本读取', () => {
  it('按相对路径读出 base64 与 mime', () => {
    const root = makeRoot()
    write(root, 'bug-261010/orig.png')

    expect(readSample('bug-261010/orig.png', { root })).toEqual({
      name: 'bug-261010/orig.png',
      mime: 'image/png',
      base64: TREEN_BASE64,
    })
  })

  it('JPEG 两个扩展名都按 image/jpeg 交出', () => {
    const root = makeRoot()
    write(root, 'photo.jpg')
    write(root, 'photo2.jpeg')

    expect(readSample('photo.jpg', { root }).mime).toBe('image/jpeg')
    expect(readSample('photo2.jpeg', { root }).mime).toBe('image/jpeg')
  })

  it('名字越界一律 400：路径不是来自服务端自己列的清单，而是 URL 里的任意串', () => {
    const root = makeRoot()
    write(root, 'top.png')
    const outside = join(root, '..', 'escaped.png')
    writeFileSync(outside, TREEN_TEXT)

    for (const name of ['../escaped.png', 'a/../../escaped.png', '/etc/hosts', '', '.', '..']) {
      const attempt = () => readSample(name, { root })
      expect(attempt, name).toThrow(DevRouteError)
      expect(attempt, name).toThrow(expect.objectContaining({ statusCode: 400 }))
    }
    rmSync(outside, { force: true })
  })

  it('名单里没有或不合格式的缺失/有害请求分别落到 404 与 400', () => {
    const root = makeRoot()
    write(root, 'top.png')

    expect(() => readSample('missing.png', { root })).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    )
    expect(() => readSample('notes.txt', { root })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    )
  })
})

describe('仓根定位', () => {
  /**
   * 锚点在模块自身位置而非 cwd：dev server 与生产产物的 cwd 不同，而 zRefs 只在仓根。
   * 期望值由测试文件位置算出（另一条路径），不是拿实现的返回值自查。
   */
  it('自本模块上溯到 pnpm-workspace.yaml 所在的仓根，再指向其下的 zRefs', () => {
    const expected = new URL('../../../zRefs', import.meta.url).pathname

    expect(zRefsRoot()).toBe(expected)
  })
})
