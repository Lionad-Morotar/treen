// 冻结域公开面。刻意不含 electron-adapters：那层在 import 期即触碰 electron 运行时，
// 若被桶文件带出，任何导入本桶的纯逻辑测试都会连带加载 Electron 而失败。
// Electron 绑定只由主进程入口按需直接引用。
export * from './geometry'
export * from './latest-gate'
export * from './shortcuts'
export * from './window-options'
export * from './controller'
export * from './frame-capture'
