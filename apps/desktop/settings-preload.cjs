// 设置窗的 preload。CJS（.cjs）而非 ESM：包体是 "type":"module"，而 sandbox 渲染进程的 preload
// 不支持 ESM，`.js` 会被按 ESM 解析导致 preload 加载失败；扩展名定死为 .cjs。
//
// 只暴露两个方法、不暴露 ipcRenderer 本体：渲染层能自造任意通道会绕开主进程的校验面。
// 通道字符串在此以字面量重复（preload 是静态 CJS，无法 import TS 契约包），
// 由 test/settings-preload.spec.ts 与 IPC_CHANNELS 对拍防漂移。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('treenSettings', {
  get: () => ipcRenderer.invoke('treen:settings-get'),
  set: (patch) => ipcRenderer.invoke('treen:settings-set', patch),
})
