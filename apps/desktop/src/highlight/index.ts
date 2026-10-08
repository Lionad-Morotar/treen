// 候选区域域的公开面。刻意不含 electron-candidates：那层在 import 期即触碰 electron 运行时，
// 被桶文件带出会让纯逻辑测试连带加载 Electron 而失败（与 freeze/index.ts 同一约定）。
export * from './candidates'
export * from './pixels'
