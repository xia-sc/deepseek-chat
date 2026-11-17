const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染进程可用的桌面能力：模型供应商配置的读写。
 * 浏览器环境下没有这个桥，应用会自动退回 localStorage。
 */
contextBridge.exposeInMainWorld('desktop', {
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (data) => ipcRenderer.invoke('config:write', data),
  configPath: () => ipcRenderer.invoke('config:path'),
  revealConfig: () => ipcRenderer.invoke('config:reveal'),
})
