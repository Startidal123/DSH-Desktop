import { contextBridge, ipcRenderer } from 'electron'

const subscribe = (channel, callback) => {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('dsh', {
  getState: () => ipcRenderer.invoke('dsh:getState'),
  newSession: () => ipcRenderer.invoke('dsh:newSession'),
  selectSession: (id) => ipcRenderer.invoke('dsh:selectSession', id),
  deleteSession: (id) => ipcRenderer.invoke('dsh:deleteSession', id),
  renameSession: (id, title) => ipcRenderer.invoke('dsh:renameSession', id, title),
  togglePinSession: (id) => ipcRenderer.invoke('dsh:togglePinSession', id),
  sendPrompt: (text, images, mode) => ipcRenderer.invoke('dsh:sendPrompt', text, images, mode),
  interrupt: () => ipcRenderer.invoke('dsh:interrupt'),
  decideApproval: (id, outcome) => ipcRenderer.invoke('dsh:decideApproval', id, outcome),
  listChangePlans: () => ipcRenderer.invoke('dsh:listChangePlans'),
  checkHarnessPatches: () => ipcRenderer.invoke('dsh:checkHarnessPatches'),
  configLocations: () => ipcRenderer.invoke('dsh:configLocations'),
  openConfigFolder: () => ipcRenderer.invoke('dsh:openConfigFolder'),
  setNativeTheme: (theme) => ipcRenderer.invoke('dsh:setNativeTheme', theme),
  contextMenuStatus: () => ipcRenderer.invoke('dsh:contextMenuStatus'),
  registerContextMenu: () => ipcRenderer.invoke('dsh:registerContextMenu'),
  unregisterContextMenu: () => ipcRenderer.invoke('dsh:unregisterContextMenu'),
  harnessStatus: () => ipcRenderer.invoke('dsh:harnessStatus'),
  harnessUpdate: () => ipcRenderer.invoke('dsh:harnessUpdate'),
  applyHarnessPatches: () => ipcRenderer.invoke('dsh:applyHarnessPatches'),
  clientStatus: () => ipcRenderer.invoke('dsh:clientStatus'),
  clientUpdate: () => ipcRenderer.invoke('dsh:clientUpdate'),
  onClientProgress: (cb) => subscribe('dsh:clientProgress', cb),
  onHarnessProgress: (cb) => subscribe('dsh:harnessProgress', cb),
  restart: () => ipcRenderer.invoke('dsh:restart'),
  updateConfig: (partial) => ipcRenderer.invoke('dsh:updateConfig', partial),
  addCustomModel: (entry) => ipcRenderer.invoke('dsh:addCustomModel', entry),
  removeCustomModel: (provider) => ipcRenderer.invoke('dsh:removeCustomModel', provider),
  pickWorkspace: () => ipcRenderer.invoke('dsh:pickWorkspace'),
  onSnapshot: (cb) => subscribe('dsh:snapshot', cb),
  onRuntime: (cb) => subscribe('dsh:runtime', cb),
})
