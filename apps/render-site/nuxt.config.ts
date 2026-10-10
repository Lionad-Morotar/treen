import { fileURLToPath } from 'node:url'
import { RENDER_SITE_DEV_ROUTES, RENDER_SITE_HOST, RENDER_SITE_PORT, RENDER_SITE_ROUTES } from '@treen/ipc'

// 处理器绝对路径：Nitro 会用别名替换后按 srcDir 解析 handler 路径，传绝对路径可绕开
// srcDir/别名随版本漂移的歧义（见 nitropack 的 resolveNitroPath）。
const handlerDir = fileURLToPath(new URL('./server/handlers/', import.meta.url))

export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  // 只跑客户端渲染。本站页面是 mermaid 画布，渲染必须在浏览器里跑才有意义，SSR 无收益；而服务端
  // 渲染路径要与 /api/render 的 jsdom 垫片共处一个进程，垫片会往 globalThis 装 window 等浏览器全局，
  // 把同进程 SSR 的模块求值带偏（vue-router 的 isBrowser 在加载期固化为 true，随后走到裸 history 抛错，
  // 且只在先渲染过再访问页面的顺序下复现）。关掉 SSR 即从构造上消除这层互斥。
  ssr: false,
  // 只绑回环，端口取自 @treen/ipc 的共享常量，避免壳层与渲染站各写一份字面量。
  devServer: { host: RENDER_SITE_HOST, port: RENDER_SITE_PORT },
  nitro: {
    // 路由路径直接由 RENDER_SITE_ROUTES 派生，而非靠 server/api 的文件名恰好同形，
    // 使契约常量成为唯一事实源，两侧不会因改名而漂移。
    handlers: [
      { route: RENDER_SITE_ROUTES.render, handler: `${handlerDir}render.ts`, method: 'post' },
      { route: RENDER_SITE_ROUTES.health, handler: `${handlerDir}health.ts`, method: 'get' },
      // dev 调试端点同样由常量派生；它们能传图并调计费的外部 API，非 dev 环境一律 404
      // （第二道防线在 server/utils/dev-gate.ts）。
      { route: RENDER_SITE_DEV_ROUTES.ocr, handler: `${handlerDir}dev/ocr.ts`, method: 'post' },
      {
        route: RENDER_SITE_DEV_ROUTES.translate,
        handler: `${handlerDir}dev/translate.ts`,
        method: 'post',
      },
      {
        route: RENDER_SITE_DEV_ROUTES.pipeline,
        handler: `${handlerDir}dev/pipeline.ts`,
        method: 'post',
      },
    ],
    externals: {
      // mac-ocr 随包分发一个 Swift 二进制，靠 `import.meta.url` 解析 `../bin/mac-ocr`
      // （见 mac-ocr/dist/index.mjs）。一旦被打进 server bundle，import.meta.url 就变成产物自身的
      // URL，二进制路径算错、OCR 必然失败；钉成外部依赖才能让它在运行时按包所在位置解析。
      external: ['mac-ocr'],
    },
  },
})
