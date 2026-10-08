import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// 主进程单独打成一份 ESM 产物供 Electron 加载：Electron 运行时无法直接执行 TS 源，
// main 字段必须指向构建产物。复用仓内已有的 vite，不引入只支持 vite ≤7 的 electron-vite。
export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'out',
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
})
