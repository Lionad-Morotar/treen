// 选区域公开面。刻意不含 electron-clipboard：那层在 import 期即触碰 electron 运行时，
// 若被桶文件带出，任何导入本桶的纯逻辑测试都会连带加载 Electron 而失败。
export * from './composite'
export * from './selection'
