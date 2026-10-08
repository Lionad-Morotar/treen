import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// 真链路冒烟入口：把 test/e2e 下的 TS 脚本打成一份可直接交给 Electron 执行的 CJS。
// 与主进程构建分离（主进程走 vite.config.ts 的 ESM 产物），因为冒烟脚本必须能 require electron
// 且不依赖渲染端；打成 CJS 免去 Electron ESM 主进程对具名导入的兼容性顾虑。
// 复用仓内既有 vite，不引入打包器依赖。
export default defineConfig({
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
      external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
})
