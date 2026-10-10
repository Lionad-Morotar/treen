// mermaid 纯逻辑的公开面：检测、归一化、节点标签。全部不触碰 mermaid 运行时与 jsdom，
// 语法校验（parse.ts）留在桌面壳——它在 import 期即拉起 mermaid 与其 DOM 垫片，是校验专用的重依赖，
// 共享层不该为「只做检测与归一化」的调用方背上它。
export * from './detect'
export * from './normalize'
export * from './candidates'
export * from './labels'
