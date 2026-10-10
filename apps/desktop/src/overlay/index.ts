// 覆盖渲染域的公开面：布局引擎与图表落点的真源在共享层（渲染站服务端要复用同一份），
// 桌面壳只再导出并补上依赖冻结域的动作装配。真实渲染侧另见 overlay.html 与 freeze/electron-adapters.ts。
export * from '@treen/shared/overlay'
// latest-gate 语义上不专属覆盖域，已上移冻结域；此处保留再导出，装配侧 import 不变。
export * from '../freeze/latest-gate'
export * from './region-action'
