import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// 主进程单独打成一份 CJS 产物供 Electron 加载：Electron 运行时无法直接执行 TS 源，main 字段必须指向构建产物。
//
// 用 CJS 而非 ESM：包体 "type":"module" 下 ESM 产物看似天然，但依赖图里有 CJS 包（dotenv），
// rolldown 会把它包成 __commonJSMin 并用 __require 兜底 require("fs") 一类内建模块，而 ESM 产物
// 运行在无 require 的宿主里会直接抛「Calling require for "fs"」并让应用在加载期崩溃——本项目
// 实测 Electron 44 启动即挂。electron 主进程用 CJS 是久经使用的路径，`require` 与 `import.meta`
// 语义都稳定。主进程与渲染端产物互不影响。
export default defineConfig({
  // CJS 产物没有 import.meta 语义，rolldown 默认会把它替成空对象并给出警示。
  // 这里显式声明同一语义，把「本产物不依赖 import.meta 真值」写成构建配置而非隐式行为；
  // 依赖 shared/env.ts 的守卫式回落在 url 缺失时退到 __dirname。
  define: {
    'import.meta': '{}',
  },
  build: {
    target: 'node22',
    outDir: 'out',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/main.ts',
      formats: ['cjs'],
      fileName: () => 'main.cjs',
    },
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
})
