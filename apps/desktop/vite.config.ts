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
      // get-windows 与 mac-ocr 必须留在产物之外：两者都在 macOS 侧靠 import.meta.url 定位随包分发的
      // 二进制，打进 CJS 产物后既没有真正的 import.meta，二进制路径也会算错。运行时经动态 import 加载。
      // external 只管「不打进产物」，解析仍在运行时按产物位置进行：mac-ocr 虽经 shared 引入，
      // 运行时不会去 shared 的 node_modules 找，故 desktop 侧仍须声明该依赖，否则 OCR 一动就 MODULE_NOT_FOUND。
      // mermaid 与 jsdom 同理留在产物外：mermaid 是纯 ESM 且体量巨大，jsdom 只在 Node 侧给 mermaid 垫 DOM，
      // 两者都经运行时动态 import 加载（CJS 下动态 import ESM 可用）。
      external: [
        'electron',
        'get-windows',
        'mac-ocr',
        'mermaid',
        'jsdom',
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
  },
})
