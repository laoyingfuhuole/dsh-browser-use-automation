'use strict'

const { randomBytes } = require('node:crypto')
const { statSync, realpathSync, accessSync, constants, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { join, isAbsolute } = require('node:path')

function installNativeUI(session, ipcMain, controllers) {
  session.registerPreloadScript({ type: 'frame', filePath: join(__dirname, 'native-preload.cjs') })
  ipcMain.on('dsh-browser-native-ui', (event, payload) => {
    const controller = controllers.get(event.sender)
    if (!controller) { event.returnValue = { accepted: false }; return }
    controller.receive(event, payload)
  })
  session.setPermissionCheckHandler(() => false)
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const controller = controllers.get(contents)
    if (!controller) { callback(false); return }
    controller.permission(permission, callback, details)
  })
}

function createNativeUI({ contents, version, interrupt, assertLive, assertOperation, whileLive, command, directory, enabled }) {
  const pending = new Map()
  const audit = []
  let capabilities = enabled
  function answer(entry, value) {
    if (!entry.finish) return
    entry.finish(value)
  }
  function remember(request, outcome) {
    audit.push({ id: request.id, kind: request.kind, outcome })
    if (audit.length > 20) audit.shift()
  }
  function add(kind, detail, finish) {
    if (!capabilities.requests || (['print', 'upload'].includes(kind) && !capabilities.files)) {
      finish?.({ accepted: false })
      const request = { id: randomBytes(16).toString('hex'), kind, ...detail }
      remember(request, 'rejected-component-disabled')
      interrupt('browser request rejected because the required component is disabled; enable it before a new user-requested operation')
      return undefined
    }
    if (pending.size >= 10) {
      finish?.({ accepted: false })
      throw new Error('too many pending browser requests; resolve or dismiss existing requests first')
    }
    const request = { id: randomBytes(16).toString('hex'), kind, ...detail }
    pending.set(request.id, { request, version: version(), finish })
    interrupt(`Browser ${kind} request is pending (${request.id}). Do not retry the page action. Use browser_use_requests to inspect and ask the user in the main conversation.`)
    return request
  }
  function get(id, kind) {
    assertLive()
    const entry = pending.get(id)
    if (!entry || (kind && entry.request.kind !== kind) || entry.version !== version()) {
      throw new Error('stale browser request; inspect current requests before responding')
    }
    return entry
  }
  function resolve(id, accepted, value) {
    const entry = get(id)
    if (typeof accepted !== 'boolean') throw new TypeError('accepted must be boolean')
    if (value !== undefined && (entry.request.kind !== 'prompt' || typeof value !== 'string' || value.length > 10000)) {
      throw new TypeError('value is only valid for a prompt and must be at most 10000 characters')
    }
    if (accepted && !['alert', 'confirm', 'prompt', 'permission'].includes(entry.request.kind)) {
      throw new Error('this request requires a dedicated upload or PDF tool, or is unsupported')
    }
    pending.delete(id)
    answer(entry, { accepted, value: value ?? entry.request.defaultValue ?? '' })
    remember(entry.request, accepted ? 'accepted' : 'dismissed')
    return { id, accepted }
  }
  function invalidate(predicate = () => true) {
    for (const [id, entry] of pending) {
      if (!predicate(entry)) continue
      try { answer(entry, { accepted: false }) } catch (error) {
        console.error(`[dsh-browser-use-automation] could not invalidate browser request ${entry.request.id}: ${error.message}`)
      }
      remember(entry.request, 'invalidated')
      pending.delete(id)
    }
  }
  return {
    setEnabled(value) {
      if (capabilities.requests && !value.requests) invalidate()
      else if (capabilities.files && !value.files) invalidate(entry => entry.fileRequest || ['upload', 'print'].includes(entry.request.kind))
      capabilities = value
    },
    status() { return { requests: [...pending.values()].map(entry => entry.request), audit: [...audit] } },
    assertUnblocked() {
      if ([...pending.values()].some(entry => ['alert', 'confirm', 'prompt', 'permission'].includes(entry.request.kind))) {
        throw new Error('browser request is pending; use browser_use_requests and respond before another page operation')
      }
    },
    resolve, invalidate,
    receive(event, payload) {
      if (!payload || !['alert', 'confirm', 'prompt', 'print', 'unsupported'].includes(payload.kind)) {
        event.returnValue = { accepted: false }
        return
      }
      const kind = payload.kind
      try {
        const detail = {
          url: String(event.senderFrame?.url ?? contents.getURL()).slice(0, 2048),
          message: String(payload.message ?? '').slice(0, 2000),
          ...kind === 'prompt' ? { defaultValue: String(payload.defaultValue ?? '').slice(0, 2000) } : {},
        }
        const finish = ['alert', 'confirm', 'prompt'].includes(kind) ? answer => { event.returnValue = answer } : undefined
        add(kind, detail, finish)
        if (!finish) event.returnValue = { accepted: false }
      } catch (error) {
        console.error(`[dsh-browser-use-automation] browser UI request failed: ${error.message}`)
        event.returnValue = { accepted: false }
      }
    },
    permission(permission, callback, details = {}) {
      try {
        const url = String(details.requestingUrl ?? contents.getURL()).slice(0, 2048)
        // 摄像头、定位、外部应用等还会触发 OS 授权/切前台；未有等价后台流程时不能承诺“允许即可完成”。
        if (!['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'clipboard-write'].includes(permission)) {
          callback(false)
          add('unsupported', { url, message: `权限 ${permission} 尚无可靠后台授权流程，已拒绝；不会弹出系统授权或伪造许可。`, permission })
          return
        }
        add('permission', { url, message: `网页请求权限：${permission}`, permission }, answer => callback(answer.accepted === true))
      } catch (error) {
        console.error(`[dsh-browser-use-automation] permission request failed: ${error.message}`)
      }
    },
    async fileChooser(params) {
      if (!capabilities.files || !capabilities.requests) {
        remember({ id: randomBytes(16).toString('hex'), kind: 'upload' }, 'rejected-component-disabled')
        interrupt('file chooser rejected: both file and request components must be enabled')
        return
      }
      // 来源解析完成前仅暴露不可授权的占位请求；不把顶层网址误当成 iframe 上传目的地。
      const request = add('unsupported', {
        url: '',
        message: '文件选择器来源解析中，请稍后重新查询，不要重复点击。',
        multiple: params.mode === 'selectMultiple',
      })
      const entry = pending.get(request.id)
      entry.fileRequest = true
      try {
        const tree = await command('Page.getFrameTree', {})
        const find = node => {
          if (node.frame.id === params.frameId) return node.frame
          for (const child of node.childFrames ?? []) {
            const match = find(child)
            if (match) return match
          }
        }
        const frame = find(tree.frameTree)
        if (!frame?.url) throw new Error('could not establish the requesting frame URL')
        if (get(request.id) !== entry) throw new Error('file chooser request changed')
        request.url = frame.url.slice(0, 2048)
        request.kind = params.backendNodeId ? 'upload' : 'unsupported'
        request.message = params.backendNodeId
          ? '网页请求选择上传文件；请显式提供并授权文件路径。'
          : '此文件选择器没有 HTML file input，后台模式不支持。'
        entry.backendNodeId = params.backendNodeId
      } catch (error) {
        if (pending.get(request.id) === entry) request.message = `文件选择器来源无法确认，禁止上传：${error.message}`
        throw error
      }
    },
    async upload(id, paths, guard) {
      if (!capabilities.files || !capabilities.requests) throw new Error('file or request component disabled')
      guard()
      const entry = get(id, 'upload')
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 32
        || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) {
        throw new TypeError('upload requires 1–32 absolute regular file paths')
      }
      if (!entry.request.multiple && paths.length !== 1) throw new Error('this input accepts only one file')
      const files = paths.map(path => {
        const canonical = realpathSync(path)
        if (!statSync(canonical).isFile()) throw new Error('directory uploads are not supported')
        accessSync(canonical, constants.R_OK)
        return canonical
      })
      const node = await command('DOM.describeNode', { backendNodeId: entry.backendNodeId })
      guard()
      const attributes = node.node?.attributes ?? []
      const attr = Object.fromEntries(Array.from({ length: attributes.length / 2 }, (_, index) => attributes.slice(index * 2, index * 2 + 2)))
      if (node.node?.nodeName !== 'INPUT' || attr.type?.toLowerCase() !== 'file' || Object.hasOwn(attr, 'webkitdirectory')) {
        throw new Error('upload target must be a regular HTML file input, not a directory picker')
      }
      if (get(id, 'upload') !== entry) throw new Error('upload request changed')
      pending.delete(id)
      // 一次性消耗已审核请求；失败可能已产生页面效果，不把它恢复为可重复上传的授权。
      remember(entry.request, 'upload-dispatched')
      await command('DOM.setFileInputFiles', { backendNodeId: entry.backendNodeId, files }, () => {
        guard()
        if (!capabilities.files || !capabilities.requests) throw new Error('file or request component disabled before upload dispatch')
        if (entry.version !== version()) throw new Error('page changed before upload dispatch')
      })
      guard()
      return { id, files: files.length }
    },
    async pdf() {
      if (!capabilities.files) throw new Error('file component disabled')
      assertOperation()
      if ([...pending.values()].some(entry => ['alert', 'confirm', 'prompt', 'permission'].includes(entry.request.kind))) {
        throw new Error('resolve the pending browser request before PDF export')
      }
      const captured = version()
      const data = await whileLive(() => contents.printToPDF({ printBackground: true }))
      assertOperation()
      if (captured !== version()) throw new Error('page changed during PDF export; inspect before retrying')
      if (!Buffer.isBuffer(data) || data.subarray(0, 5).toString() !== '%PDF-') throw new Error('browser returned invalid PDF data')
      mkdirSync(directory, { recursive: true })
      const folder = mkdtempSync(join(directory, 'pdf-'))
      const path = join(folder, 'page.pdf')
      writeFileSync(path, data, { flag: 'wx' })
      for (const [id, entry] of pending) if (entry.request.kind === 'print') {
        pending.delete(id)
        remember(entry.request, 'exported-pdf')
      }
      return { path, bytes: data.length, mime: 'application/pdf' }
    },
  }
}

module.exports = { installNativeUI, createNativeUI }
