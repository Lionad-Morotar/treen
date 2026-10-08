#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 应用启动冒烟：真实起一次 Electron 主进程，断言它能加载产物、读到配置、注册好全局热键，
 * 然后杀掉进程。补的是「构建通过但一跑就崩」这一类只在运行时才暴露的缺口
 * （产物把 CJS 依赖打成 ESM、import.meta 在 CJS 下被替成空对象等，都在此暴露）。
 *
 * 会短暂弹出主窗口，属开发机本地验证；不覆盖真实截屏与冻结交互。
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..', '..')
const mainEntry = resolve(packageRoot, 'out', 'main.cjs')
const require = createRequire(import.meta.url)

const EXPECTED = ['Treen 启动', '冻结热键就绪']
const TIMEOUT_MS = 30_000

function finish(ok, detail) {
  process.stdout.write(`\nTREEN_APP_SMOKE ${JSON.stringify({ ok, ...detail })}\n`)
  process.exit(ok ? 0 : 1)
}

if (!existsSync(mainEntry)) {
  finish(false, { error: `未找到主进程产物：${mainEntry}（先跑 pnpm build:desktop）` })
}

const electronBinary = require('electron')
const child = spawn(electronBinary, [packageRoot], {
  cwd: packageRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
const seen = new Set()
const timer = setTimeout(() => {
  child.kill('SIGKILL')
  finish(false, { error: `等待启动日志超时（${TIMEOUT_MS}ms）`, output, seen: [...seen] })
}, TIMEOUT_MS)

function onChunk(chunk) {
  output += chunk.toString()
  for (const needle of EXPECTED) {
    if (output.includes(needle)) {
      seen.add(needle)
    }
  }
  if (EXPECTED.every((needle) => seen.has(needle))) {
    clearTimeout(timer)
    child.kill('SIGKILL')
    finish(true, { seen: [...seen], output })
  }
}

child.stdout.on('data', onChunk)
child.stderr.on('data', onChunk)
child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (EXPECTED.every((needle) => seen.has(needle))) {
    return
  }
  finish(false, { error: `进程提前退出（code=${code} signal=${signal}）`, output, seen: [...seen] })
})
