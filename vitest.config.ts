import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/**
 * 单测里要能直接装载 `.vue`（调试页的行为挂在组件上，抽成纯函数反而测不到真实链路），
 * 故在根配置上装一次 vue 插件并补上 Nuxt 那两个目录别名；其余包不引 `.vue`，装上无副作用。
 */
const renderSite = fileURLToPath(new URL('./apps/render-site/', import.meta.url))

export default defineConfig({
  plugins: [vue()],
  // `import.meta.dev` 是 Nuxt 在构建期注入的字面量，单测直接装 .vue 时并不存在；按 dev 取值，
  // 好让组件测试走的是调试内容那一支。
  define: {
    'import.meta.dev': 'true',
  },
  resolve: {
    alias: {
      '~': `${renderSite}app`,
      '@': `${renderSite}app`,
      '#shared': `${renderSite}shared`,
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/test/**/*.spec.ts', 'apps/*/test/**/*.spec.ts'],
  },
})
