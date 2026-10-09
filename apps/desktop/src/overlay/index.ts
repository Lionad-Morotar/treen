// 覆盖渲染域的公开面：布局引擎、图表落点、装配。全部为纯逻辑，不触碰 Electron 运行时，
// 故可整体被纯 Node 测试导入；真实渲染侧另见 overlay.html 与 freeze/electron-adapters.ts。
export * from './layout'
export * from './chart-region'
export * from './compose'
export * from './latest-gate'
