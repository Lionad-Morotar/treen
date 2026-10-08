export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: false },
  // 只跑客户端渲染。本站页面是 mermaid 画布，渲染必须在浏览器里跑才有意义，SSR 无收益；而服务端
  // 渲染路径要与 /api/render 的 jsdom 垫片共处一个进程，垫片会往 globalThis 装 window 等浏览器全局，
  // 把同进程 SSR 的模块求值带偏（vue-router 的 isBrowser 在加载期固化为 true，随后走到裸 history 抛错，
  // 且只在先渲染过再访问页面的顺序下复现）。关掉 SSR 即从构造上消除这层互斥。
  ssr: false,
})
