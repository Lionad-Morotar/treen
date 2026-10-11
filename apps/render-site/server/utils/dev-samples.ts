import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DevRouteError } from './dev-gate'

/**
 * `/api/dev/samples*` 的样本库：把仓库 `zRefs/` 下的图列出来、按名字交出内容，
 * 让 `/dev/pipeline` 调试页能一键加载固定的回归用图，不必每次都重新拖一张截图进来。
 *
 * zRefs 被 gitignore 排除在仓外，缺目录是常态而非故障，故缺目录、空目录、格式不符一律
 * 走正常返回或明确的 400/404，不假设 zRefs 一定在盘上。
 */

/** 仓库根标识：出现即停止上溯，避免越过本仓把其它项目的目录当成根。 */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

/** 相对 zRefs 的路径最多两段：够放「探针目录/图」，又不致把整仓展开一遍。 */
const MAX_RELATIVE_SEGMENTS = 2

/**
 * 只收 OCR 认得的格式。
 *
 * 清单要与服务端尺寸解析同源：zRefs 里躺着 webp、gif 时让它们出现在下拉里，只是把一次
 * 「读不出图像尺寸」推迟到按下 OCR 之后，不如一开始就不列。
 */
const SUPPORTED: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

export interface DevSampleEntry {
  /** 相对 zRefs 的路径；同时也是读取时的名字 */
  name: string
  size: number
}

export interface DevSampleList {
  /** 目录不存在时为 null，供页面区分「目录不在」与「目录里没有图」 */
  root: string | null
  samples: DevSampleEntry[]
}

export interface DevSamplePayload {
  name: string
  mime: string
  base64: string
}

export interface DevSamplesOptions {
  /** 注入根目录以便单测；缺省自本模块上溯到仓根下的 zRefs */
  root?: string | null
}

/**
 * 本模块所在目录，作为上溯仓根的起点。
 *
 * 锚点取模块位置而非 cwd：同一份服务端源码在 dev server（cwd 为 apps/render-site）与生产
 * 产物（cwd 为 .output/server）下的 cwd 不同，而 zRefs 只在仓根。
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 定位 zRefs 目录；找不到仓根返回 null。
 *
 * 返回 null 而非抛错是刻意的：这里回答的是「这台机器上有没有样本可用」，属于页面的空态，
 * 抛错会把缺目录渲染成一张异常面板。
 */
export function zRefsRoot(): string | null {
  let current: string | null = MODULE_DIR
  while (current !== null) {
    if (existsSync(join(current, WORKSPACE_MARKER))) {
      return join(current, 'zRefs')
    }
    const parent = dirname(current)
    current = parent === current ? null : parent
  }
  return null
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

/** 递归收图：只看支持的格式、限深、不跟随符号链接。 */
function collect(root: string, prefix: string, depth: number, out: DevSampleEntry[]): void {
  if (depth > MAX_RELATIVE_SEGMENTS) {
    return
  }
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    // 跳过符号链接：zRefs 里常见链回上级的软链目录，跟随会把这次列举拖进环路。
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) {
      continue
    }
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      collect(root, relative, depth + 1, out)
      continue
    }
    if (SUPPORTED[extensionOf(entry.name)] === undefined) {
      continue
    }
    out.push({ name: relative, size: statSync(join(root, relative)).size })
  }
}

/**
 * 列出可用于回归的样本图。
 *
 * 目录缺失返回 `root: null` 而不是报错，这正是页面下拉要显示的空态。
 */
export function listSamples(options: DevSamplesOptions = {}): DevSampleList {
  const root = 'root' in options ? options.root : zRefsRoot()
  if (root === null || root === undefined || !existsSync(root)) {
    return { root: null, samples: [] }
  }
  const samples: DevSampleEntry[] = []
  collect(root, '', 1, samples)
  samples.sort((left, right) => left.name.localeCompare(right.name))
  return { root, samples }
}

/**
 * 按名字读出一张样本图的内容。
 *
 * 名字来自 URL 路径、是不可信输入，故三重校验后才碰文件系统：必须是相对路径（拒绝对地址、
 * 空串、`.`/`..`、任何 `..` 分段）、必须是 OCR 支持的扩展名、拼接后必须仍落在根目录内。
 * 任一条不满足一律 400——把「名字写错」当 404 会让使用者误以为是自己把样本删了。
 */
export function readSample(name: string, options: DevSamplesOptions = {}): DevSamplePayload {
  const root = 'root' in options ? options.root : zRefsRoot()
  if (root === null || root === undefined) {
    throw new DevRouteError('样本目录不存在', 404)
  }
  if (name.trim() === '' || name.startsWith('/') || name.includes('\0')) {
    throw new DevRouteError('样本名需是相对 zRefs 的路径', 400)
  }

  const segments = name.split(/[\\/]/)
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new DevRouteError('样本名不得包含空分段、. 或 ..', 400)
  }
  const mime = SUPPORTED[extensionOf(name)]
  if (mime === undefined) {
    throw new DevRouteError('样本需是 PNG 或 JPEG', 400)
  }

  const resolved = join(root, segments.join(sep))
  if (!resolved.startsWith(`${root}${sep}`)) {
    throw new DevRouteError('样本名超出样本目录范围', 400)
  }
  if (!existsSync(resolved)) {
    throw new DevRouteError(`样本不存在：${name}`, 404)
  }

  return { name, mime, base64: readFileSync(resolved).toString('base64') }
}
