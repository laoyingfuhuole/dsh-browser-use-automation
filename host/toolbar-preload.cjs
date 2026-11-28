'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserToolbar', {
  action: (action, tabId, value) => ipcRenderer.invoke('dsh:toolbar', action, tabId, value),
  onTabs: listener => ipcRenderer.on('dsh:tabs', (_event, state) => listener(state)),
  onAddress: listener => ipcRenderer.on('dsh:address', () => listener()),
})
