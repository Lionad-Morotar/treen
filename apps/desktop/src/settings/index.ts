// 设置域的公开面：存储与 IPC 处理器均为纯逻辑（Electron 能力经注入），可被纯 Node 测试导入。
// 窗口创建与 preload 路径是运行时绑定，留在 main 装配层。
export * from './store'
export * from './ipc'
