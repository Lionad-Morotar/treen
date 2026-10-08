import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseDotenv } from 'dotenv'

export const DEEPSEEK_KEY_ENV_VAR = 'DEEPSEEK_KEY'
export const LOCAL_ENV_FILENAME = '.env.local'

/** 仓库根标识：出现即停止向上查找，避免越过本仓读到无关项目的 .env.local。 */
const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

export interface ReadDeepSeekKeyOptions {
  /** 显式指定 .env.local 路径；缺省时自本模块所在目录向上查找 */
  envFile?: string
  /** 注入环境变量来源（测试用）；缺省读 process.env */
  env?: NodeJS.ProcessEnv
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 自 startDir 逐级向上查找 .env.local，止于仓库根（见 WORKSPACE_MARKER）或家目录。
 * 锚点是模块自身位置而非 cwd：Electron 打包后 cwd 落在 App 包内，而开发期仓库根的
 * .env.local 才是密钥真源，向上查找同时覆盖 worktree 层级。
 * 必须设边界——否则本仓无 .env.local 时会继续上溯，把家目录或上级其它项目遗留的
 * .env.local 当成真源，静默用到无关的 key。
 */
export function findLocalEnvFile(startDir: string = MODULE_DIR): string | undefined {
  const home = homedir()
  let current = startDir
  for (;;) {
    const candidate = join(current, LOCAL_ENV_FILENAME)
    if (existsSync(candidate)) {
      return candidate
    }
    if (existsSync(join(current, WORKSPACE_MARKER)) || current === home) {
      return undefined
    }
    const parent = dirname(current)
    if (parent === current) {
      return undefined
    }
    current = parent
  }
}

function readVariable(file: string, name: string): string | undefined {
  let content: string
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    // 文件存在却读不出来（权限不足、路径是目录等）属配置损坏：给出带路径的上下文，
    // 而不是让底层 EACCES/EISDIR 裸奔到调用方。
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法读取环境文件 ${file}：${reason}`, { cause: error })
  }
  const value = parseDotenv(content)[name]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/**
 * 解析 DeepSeek API key：优先进程环境变量，其次 .env.local。
 * 找不到返回 undefined（读取方自行决定是否致命）。
 */
export function readDeepSeekKey(options: ReadDeepSeekKeyOptions = {}): string | undefined {
  const env = options.env ?? process.env
  const fromEnv = env[DEEPSEEK_KEY_ENV_VAR]
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return fromEnv.trim()
  }

  const envFile = options.envFile ?? findLocalEnvFile()
  if (envFile === undefined || !existsSync(envFile)) {
    return undefined
  }
  return readVariable(envFile, DEEPSEEK_KEY_ENV_VAR)
}

/** readDeepSeekKey 的致命变体：缺失时抛出可操作的错误而非返回 undefined。 */
export function requireDeepSeekKey(options: ReadDeepSeekKeyOptions = {}): string {
  const key = readDeepSeekKey(options)
  if (key === undefined) {
    throw new Error(
      `未找到 ${DEEPSEEK_KEY_ENV_VAR}：请在仓库根创建 .env.local（${DEEPSEEK_KEY_ENV_VAR}=...）或导出同名环境变量。`,
    )
  }
  return key
}
