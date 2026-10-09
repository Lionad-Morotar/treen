import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// 真链路冒烟入口：把 test/e2e 下的 TS 脚本打成一份可直接交给 Electron 执行的 CJS。
// 与主进程构建分离（主进程走 vite.config.ts 的 CJS 产物），因为冒烟脚本必须能 require electron
// 且不依赖渲染端；打成 CJS 免去 Electron ESM 主进程对具名导入的兼容性顾虑。
// 复用仓内既有 vite，不引入打包器依赖。
export default defineConfig({
  // 与主进程构建同一处置：入口经 shared/env.ts 触到 import.meta，CJS 产物里没有真 import.meta，
  // 显式声明空对象语义，让其守卫式回落到 __dirname。
  define: {
    'import.meta': '{}',
  },
  build: {
    target: 'node22',
    outDir: 'out',
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'test/e2e/freeze-smoke.ts',
      formats: ['cjs'],
      fileName: () => 'freeze-smoke.cjs',
    },
    rollupOptions: {
      // get-windows 与主进程构建保持同一处置：留在产物外，运行时动态 import。
      external: [
        'electron',
        'get-windows',
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
  },
})
