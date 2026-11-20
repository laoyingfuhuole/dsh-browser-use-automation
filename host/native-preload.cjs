'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// 只暴露固定类型的申请，不暴露 IPC、路径读写或授权回调；同步返回保留 confirm/prompt 的网页语义。
contextBridge.exposeInMainWorld('__dshBackgroundUI', (kind, message, defaultValue) =>
  ipcRenderer.sendSync('dsh-browser-native-ui', { kind, message: String(message).slice(0, 2000), defaultValue: String(defaultValue ?? '').slice(0, 2000) }))

contextBridge.executeInMainWorld({
  func: () => {
    const request = globalThis.__dshBackgroundUI
    for (const kind of ['alert', 'confirm', 'prompt']) {
      Object.defineProperty(globalThis, kind, {
        configurable: false, writable: false,
        value(message = '', defaultValue = '') {
          const answer = request(kind, message, defaultValue)
          if (kind === 'confirm') return answer?.accepted === true
          if (kind === 'prompt') return answer?.accepted === true ? String(answer.value ?? '') : null
        },
      })
    }
    Object.defineProperty(globalThis, 'print', {
      configurable: false, writable: false,
      value() { request('print', '网页请求打印；请使用 browser_use_pdf 后台导出 PDF。') },
    })
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
      if (typeof globalThis[name] !== 'function') continue
      Object.defineProperty(globalThis, name, {
        configurable: false, writable: false,
        value() {
          request('unsupported', `${name} 需要真实文件系统句柄；后台模式不伪造授权。使用普通文件上传、下载或 PDF 导出。`)
          return Promise.reject(new DOMException('File System Access pickers are unavailable in background mode', 'NotAllowedError'))
        },
      })
    }
  },
})
