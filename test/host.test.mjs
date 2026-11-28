import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { basename, dirname, join, resolve } from 'node:path'
import { createHostHarness, deferred } from './helpers/host-harness.mjs'

const commandCount = (win, method) => win.first.commands.filter(command => command.method === method).length

function download(h, win, filename = 'report.pdf', { saveError = false, total = 12 } = {}) {
  const event = { prevented: false, preventDefault() { this.prevented = true } }
  const item = Object.assign(new EventEmitter(), {
    path: undefined, received: 0, total, cancelled: false,
    getFilename: () => filename,
    getReceivedBytes() { return this.received }, getTotalBytes() { return this.total },
    setSavePath(path) { if (saveError) throw new Error('save path denied'); this.path = path },
    cancel() { this.cancelled = true; this.emit('done', {}, 'cancelled') },
    finish(state = 'completed') {
      this.received = this.total
      if (state === 'completed') h.filesystem.files.set(this.path, this.total)
      this.emit('done', {}, state)
    },
  })
  const browserSession = win?.first.options.webPreferences.session ?? h.defaultSession
  browserSession.emit('will-download', event, item, win?.first.webContents)
  return { item, event }
}

test('downloads are routed without a save dialog and same filenames get unique paths', async t => {
  const h = await createHostHarness(t)
  assert.equal(h.defaultSession.listenerCount('will-download'), 1)
  assert.deepEqual((await h.run('downloads')).result, { downloads: [] })
  assert.equal(h.natives.length, 0)
  await h.run('state', 'A')
  await h.run('state', 'B')
  const first = download(h, h.natives[0])
  const second = download(h, h.natives[0])
  const other = download(h, h.natives[1], 'other.pdf')
  assert.equal(first.event.prevented, false)
  assert.ok(first.item.path)
  assert.notEqual(first.item.path, second.item.path)
  assert.equal(basename(first.item.path), 'report.pdf')
  assert.notEqual(dirname(first.item.path), dirname(other.item.path))
  first.item.received = 5
  first.item.emit('updated', {}, 'interrupted')
  assert.equal((await h.run('downloads', 'A')).result.downloads[0].state, 'interrupted')
  first.item.emit('updated', {}, 'progressing')
  const entries = (await h.run('downloads', 'A')).result.downloads
  assert.equal(entries.length, 2)
  assert.equal(entries[0].receivedBytes, 5)
  assert.equal(entries[0].state, 'progressing')
  assert.equal((await h.run('downloads', 'B')).result.downloads.length, 1)
  first.item.finish()
  assert.equal((await h.run('downloads', 'A')).result.downloads[0].state, 'completed')
  assert.equal(first.item.listenerCount('updated'), 0)
  second.item.finish('interrupted')
  assert.match((await h.run('downloads', 'A')).result.downloads[1].error, /interrupted/)
  other.item.finish()
})

test('download names cannot escape their allocated directory and preparation failure cancels the default flow', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const fixture = download(h, h.natives[0], '../..\\folder\\CON.txt')
  assert.equal(basename(fixture.item.path), '_CON.txt')
  fixture.item.finish()
  const long = download(h, h.natives[0], '文'.repeat(200) + '.txt')
  assert.ok(Buffer.byteLength(basename(long.item.path)) <= 180)
  long.item.finish()
  const badSave = download(h, h.natives[0], 'file.pdf', { saveError: true })
  assert.equal(badSave.event.prevented, true)
  assert.match((await h.run('downloads')).result.downloads.at(-1).error, /save path denied/)
  h.filesystem.mkdtempSync = () => { throw new Error('disk denied') }
  const failed = download(h, h.natives[0], 'file.pdf')
  assert.equal(failed.event.prevented, true)
  assert.equal(failed.item.path, undefined)
  assert.match((await h.run('downloads')).result.downloads.at(-1).error, /disk denied/)
  const unknown = download(h, undefined)
  assert.equal(unknown.event.prevented, true)
})

test('close cancels only its active downloads; history and query survive a blocked page queue', async t => {
  const h = await createHostHarness(t)
  await h.run('state', 'A')
  await h.run('state', 'B')
  const first = download(h, h.natives[0])
  const other = download(h, h.natives[1])
  h.natives[0].first.page.element.focus()
  const gate = deferred()
  h.natives[0].first.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
  h.submit('insertText', 'A', { text: 'blocked' })
  await h.flush()
  assert.equal((await h.run('downloads', 'A')).result.downloads.length, 1)
  await h.run('close', 'A')
  assert.equal(first.item.cancelled, true)
  assert.equal(other.item.cancelled, false)
  assert.equal((await h.run('downloads', 'A')).result.downloads[0].state, 'cancelled')
  assert.equal(h.natives.length, 2, 'query must not recreate a closed window')
  gate.resolve({})
  other.item.finish()
  await h.flush()
})

test('reset cancels active downloads but keeps completed files and the previous history', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const complete = download(h, h.natives[0])
  complete.item.finish()
  const active = download(h, h.natives[0])
  const oldWindow = h.natives[0]
  await h.run('reset')
  assert.equal(active.item.cancelled, true)
  assert.equal(h.filesystem.files.has(complete.item.path), true)
  assert.equal((await h.run('downloads')).result.downloads.length, 2)
  const late = download(h, oldWindow)
  assert.equal(late.event.prevented, true)
  await h.run('state')
  assert.equal((await h.run('downloads')).result.downloads[0].state, 'completed')
})

test('completed download requires a saved file and terminal history stays bounded', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const missing = download(h, h.natives[0])
  missing.item.emit('done', {}, 'completed')
  assert.match((await h.run('downloads')).result.downloads[0].error, /saved file is unavailable/)
  for (let index = 0; index < 55; index++) download(h, h.natives[0], `${index}.txt`).item.finish()
  const entries = (await h.run('downloads')).result.downloads
  assert.equal(entries.length, 50)
  assert.equal(entries.at(-1).filename, '54.txt')
})

test('download admission counts existing files, reservations and concurrent work across conversations', async t => {
  const h = await createHostHarness(t, {
    existingFiles: [[resolve('/fixture/home/.dsh/browser-use/downloads', 'previous', 'old.pdf'), 20]],
    env: { BROWSER_USE_DOWNLOAD_MAX_FILE_BYTES: '10', BROWSER_USE_DOWNLOAD_MAX_CONCURRENT: '2', BROWSER_USE_DOWNLOAD_MAX_DIRECTORY_BYTES: '35' },
  })
  await h.run('state', 'A')
  await h.run('state', 'B')
  const [a, b] = h.natives
  assert.equal(download(h, a, 'too-big', { total: 11 }).event.prevented, true)
  const first = download(h, a, 'first', { total: 10 })
  assert.equal(download(h, b, 'no-room', { total: 6 }).event.prevented, true)
  const unknown = download(h, b, 'unknown', { total: 0 })
  assert.equal(unknown.event.prevented, false)
  assert.equal(download(h, a, 'concurrent', { total: 1 }).event.prevented, true)
  h.filesystem.files.set(unknown.item.path, 6)
  unknown.item.received = 6
  unknown.item.emit('updated', {}, 'progressing')
  assert.equal(unknown.item.cancelled, true)
  assert.equal(h.filesystem.files.has(unknown.item.path), false)
  assert.match((await h.run('downloads', 'B')).result.downloads.at(-1).error, /reserved byte budget/)
  first.item.finish()
  assert.equal(download(h, b, 'after-completion', { total: 6 }).event.prevented, true)
  assert.match((await h.run('pdf', 'A')).error, /directory budget/)
})

test('isolated sessions have their own callbacks and reset never reuses a partition', async t => {
  const h = await createHostHarness(t, { env: { BROWSER_USE_SESSION_MODE: 'isolated' } })
  await h.run('state', 'A')
  await h.run('state', 'B')
  const [a, b] = h.natives
  const first = a.first.options.webPreferences.session
  assert.notEqual(first, b.first.options.webPreferences.session)
  assert.notEqual(first, h.defaultSession)
  assert.equal(h.ipcMain.listenerCount('dsh-browser-native-ui'), 1)
  assert.ok(first.preload)
  assert.equal(first.permissionCheck(), false)
  download(h, a).item.finish()
  assert.equal((await h.run('downloads', 'B')).result.downloads.length, 0)
  await h.run('reset', 'A')
  await h.flush()
  assert.equal(first.cleanups, 1)
  assert.equal(first.preload, undefined)
  assert.equal(download(h, a).event.prevented, true)
  assert.equal(b.first.options.webPreferences.session.cleanups, 0)
  await h.run('state', 'A')
  assert.notEqual(h.natives[2].first.options.webPreferences.session, first)
})

test('snapshot never reads input or textarea values and keeps the ref actionable', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  const input = win.first.page.element
  input.type = 'password'
  input.value = 'fixture-password'
  const textarea = Object.assign(Object.create(input), { tagName: 'TEXTAREA', value: 'fixture-code', innerText: 'fixture-default' })
  win.first.page.document.querySelectorAll = () => [input, textarea]
  const { result } = await h.run('snapshot')
  assert.doesNotMatch(JSON.stringify(result), /fixture-(password|code|default)/)
  assert.equal(result.elements.length, 2)
  assert.equal((await h.run('type', 'A', { ref: result.elements[0].ref, text: 'x', mode: 'fast' })).ok, true)
})

function pageRequest(h, win, kind = 'confirm', message = 'Continue?') {
  const event = { sender: win.first.webContents, senderFrame: { url: win.first.page.location.href } }
  h.ipcMain.emit('dsh-browser-native-ui', event, { kind, message, defaultValue: 'default' })
  return event
}

function components(h, enabled, id = 'component-config') {
  h.send({ id, op: 'components', enabled })
  assert.equal(h.response(id)?.ok, true)
}

test('disabled tools cannot operate through their old component and shared windows stay alive', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  components(h, ['basic'])
  assert.match((await h.run('read', 'A', { component: 'read' })).error, /component is disabled/)
  assert.equal((await h.run('state', 'A', { component: 'basic' })).ok, true)
  assert.equal(h.natives[0].destroyed, false)
  assert.match((await h.run('eval', 'A', { component: 'read', expression: 'true' })).error, /component is disabled/)
  assert.equal((await h.run('eval', 'A', { component: 'basic', expression: 'true' })).result.value, 'true', 'internal assert evaluation must remain available')
})

test('disabling file component cancels active downloads and blocks future saves without native fallback', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const active = download(h, h.natives[0])
  components(h, ['basic', 'requests'])
  assert.equal(active.item.cancelled, true)
  const denied = download(h, h.natives[0])
  assert.equal(denied.event.prevented, true)
  assert.equal(denied.item.path, undefined)
  assert.match((await h.run('downloads', 'A', { component: 'files' })).error, /disabled/)
  assert.equal(h.natives[0].destroyed, false)
})

test('disabling request handling dismisses pending dialogs and cannot resurrect a late approval', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  const event = pageRequest(h, win)
  const pending = (await h.run('requests')).result.requests[0]
  components(h, ['basic', 'files'])
  assert.equal(event.returnValue.accepted, false)
  const rejected = pageRequest(h, win)
  assert.equal(rejected.returnValue.accepted, false)
  components(h, ['basic', 'files', 'requests'], 'component-config-two')
  assert.match((await h.run('respond', 'A', { requestId: pending.id, accept: true, component: 'requests' })).error, /stale/)
  assert.equal((await h.run('requests')).result.requests.length, 0)
})

test('disabling files does not dismiss an unrelated live confirmation request', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const event = pageRequest(h, h.natives[0], 'confirm')
  const confirmation = (await h.run('requests')).result.requests[0]
  components(h, ['basic', 'read', 'requests', 'eval'])
  assert.equal(event.returnValue, undefined)
  assert.equal((await h.run('requests')).result.requests[0].id, confirmation.id)
  await h.run('respond', 'A', { requestId: confirmation.id, accept: false, component: 'requests' })
  assert.equal(event.returnValue.accepted, false)
})

test('disabling request handling cancels a file-component upload before paths reach the page', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'fixture-frame', backendNodeId: 1, mode: 'selectSingle' })
  await h.flush()
  const requestId = (await h.run('requests')).result.requests[0].id
  h.filesystem.files.set('/fixture/input.txt', 1)
  const gate = deferred()
  win.first.onCommand = method => method === 'DOM.describeNode' ? gate.promise : undefined
  const id = h.submit('upload', 'A', { component: 'files', requestId, paths: ['/fixture/input.txt'] })
  await h.flush()
  components(h, ['basic', 'read', 'files', 'eval'])
  assert.match(h.response(id).error, /request-handling component disabled/)
  gate.resolve({ node: { nodeName: 'INPUT', attributes: ['type', 'file'] } })
  await h.flush()
  assert.equal(commandCount(win, 'DOM.setFileInputFiles'), 0)
  assert.equal(h.requests.has(id), false)
})

test('disabling component reports cancellation but does not release an in-flight page barrier early', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const gate = deferred()
  const win = h.natives[0]
  win.first.onCommand = method => method === 'Runtime.evaluate' ? gate.promise : undefined
  const reading = h.submit('read', 'A', { component: 'read' })
  const queued = h.submit('state', 'A', { component: 'basic' })
  await h.flush()
  components(h, ['basic'])
  assert.match(h.response(reading).error, /component disabled: read/)
  assert.equal(h.response(queued), undefined)
  win.first.onCommand = undefined
  gate.resolve({ result: { value: {} } })
  await h.flush()
  assert.equal(h.response(queued).ok, true)
})

test('page dialogs wait for an explicit response outside the blocked page queue', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  const gate = deferred()
  win.first.onCommand = method => {
    if (method === 'Runtime.evaluate') {
      pageRequest(h, win)
      return gate.promise
    }
  }
  const id = h.submit('eval', 'A', { expression: 'confirm("Continue?")' })
  await h.flush()
  assert.match(h.response(id).error, /Browser confirm request is pending/)
  const status = (await h.run('requests')).result
  assert.equal(status.requests[0].kind, 'confirm')
  assert.equal((await h.run('requests', 'B')).result.requests.length, 0)
  const requestId = status.requests[0].id
  assert.match((await h.run('state')).error, /browser request is pending/)
  assert.equal((await h.run('respond', 'B', { requestId, accept: true })).ok, false)
  const result = await h.run('respond', 'A', { requestId, accept: false })
  assert.equal(result.result.accepted, false)
  assert.equal((await h.run('requests')).result.requests.length, 0)
  gate.resolve({ result: { value: false } })
  await h.flush()
})

test('prompt, permissions and pending requests retain explicit accept/dismiss semantics and invalidate on navigation', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  const event = pageRequest(h, win, 'prompt')
  assert.equal(event.returnValue, undefined)
  const requestId = (await h.run('requests')).result.requests[0].id
  await h.run('respond', 'A', { requestId, accept: true, value: 'typed by user' })
  assert.equal(event.returnValue.accepted, true)
  assert.equal(event.returnValue.value, 'typed by user')
  let granted
  h.defaultSession.permissionRequest(win.first.webContents, 'notifications', value => { granted = value })
  assert.equal(granted, undefined)
  const permission = (await h.run('requests')).result.requests[0]
  assert.equal(permission.kind, 'permission')
  await h.run('respond', 'A', { requestId: permission.id, accept: false })
  assert.equal(granted, false)
  const old = pageRequest(h, win, 'confirm')
  const stale = (await h.run('requests')).result.requests[0].id
  win.first.webContents.emit('did-start-navigation', { isMainFrame: true })
  assert.equal(old.returnValue.accepted, false)
  assert.match((await h.run('respond', 'A', { requestId: stale, accept: true })).error, /stale/)
  assert.equal(h.defaultSession.permissionCheck(), false)
  assert.equal(win.first.options.webPreferences.disableDialogs, true)
})

test('HTML file choosers are intercepted, accept only regular files and require a current request', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  assert.ok(win.first.commands.some(command => command.method === 'Page.setInterceptFileChooserDialog' && command.params.enabled))
  win.first.webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 10, frameId: 'fixture-frame', mode: 'selectSingle' })
  await h.flush()
  const request = (await h.run('requests')).result.requests[0]
  assert.equal(request.kind, 'upload')
  assert.equal(request.multiple, false)
  win.first.onCommand = method => method === 'DOM.describeNode' ? Promise.resolve({ node: { nodeName: 'INPUT', attributes: ['type', 'file'] } }) : undefined
  h.filesystem.files.set('/fixture/input.txt', 12)
  assert.match((await h.run('upload', 'A', { requestId: request.id, paths: ['relative'] })).error, /absolute/)
  assert.match((await h.run('upload', 'A', { requestId: request.id, paths: ['/fixture/input.txt', '/fixture/input2.txt'] })).error, /only one/)
  assert.equal((await h.run('upload', 'A', { requestId: request.id, paths: ['/fixture/input.txt'] })).result.files, 1)
  const sent = win.first.commands.find(command => command.method === 'DOM.setFileInputFiles')
  assert.deepEqual(Array.from(sent.params.files), ['/fixture/input.txt'])
  assert.match((await h.run('upload', 'A', { requestId: request.id, paths: ['/fixture/input.txt'] })).error, /stale/)
})

test('print requests use a PDF tool and unsupported pickers cannot be accepted', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  pageRequest(h, win, 'print', 'Use PDF instead')
  const request = (await h.run('requests')).result.requests[0]
  assert.equal((await h.run('respond', 'A', { requestId: request.id, accept: true })).ok, false)
  const pdf = await h.run('pdf')
  assert.equal(pdf.ok, true, pdf.error)
  assert.equal(pdf.result.mime, 'application/pdf')
  assert.ok(h.filesystem.files.has(pdf.result.path))
  assert.equal((await h.run('requests')).result.requests.length, 0)
  pageRequest(h, win, 'unsupported', 'showDirectoryPicker not supported')
  const unsupported = (await h.run('requests')).result.requests[0]
  assert.equal((await h.run('respond', 'A', { requestId: unsupported.id, accept: true })).ok, false)
  assert.equal((await h.run('respond', 'A', { requestId: unsupported.id, accept: false })).ok, true)
})

test('upload cancellation before file dispatch prevents file selection and clears its RPC request', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 7, frameId: 'fixture-frame', mode: 'selectSingle' })
  await h.flush()
  const requestId = (await h.run('requests')).result.requests[0].id
  h.filesystem.files.set('/fixture/input.txt', 12)
  const gate = deferred()
  win.first.onCommand = method => method === 'DOM.describeNode' ? gate.promise : undefined
  const id = h.submit('upload', 'A', { requestId, paths: ['/fixture/input.txt'] })
  await h.flush()
  h.cancel(id)
  gate.resolve({ node: { nodeName: 'INPUT', attributes: ['type', 'file'] } })
  await h.flush()
  assert.match(h.response(id).error, /cancelled/)
  assert.equal(commandCount(win, 'DOM.setFileInputFiles'), 0)
  assert.equal(h.requests.has(id), false)
})

test('sensitive permissions stay denied and closing a window dismisses its synchronous requests', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  let granted
  h.defaultSession.permissionRequest(win.first.webContents, 'media', value => { granted = value })
  assert.equal(granted, false)
  const unsupported = (await h.run('requests')).result.requests[0]
  assert.equal(unsupported.kind, 'unsupported')
  assert.equal((await h.run('respond', 'A', { requestId: unsupported.id, accept: true })).ok, false)
  const dialog = pageRequest(h, win)
  await h.run('close')
  assert.equal(dialog.returnValue.accepted, false)
  assert.equal((await h.run('requests')).result.requests.length, 0)
})

test('browser request limits remain bounded and subframe navigation invalidates pending answers', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  for (let index = 0; index < 10; index++) pageRequest(h, win, 'print', `Print ${index}`)
  const overflow = pageRequest(h, win, 'confirm')
  assert.equal(overflow.returnValue.accepted, false)
  assert.equal((await h.run('requests')).result.requests.length, 10)
  for (const request of (await h.run('requests')).result.requests) {
    await h.run('respond', 'A', { requestId: request.id, accept: false })
  }
  const event = pageRequest(h, win, 'prompt')
  const pending = (await h.run('requests')).result.requests[0]
  win.first.webContents.emit('did-start-navigation', { isMainFrame: false })
  assert.equal(event.returnValue.accepted, false)
  assert.match((await h.run('respond', 'A', { requestId: pending.id, accept: true })).error, /stale/)
  assert.equal(win.first.options.webPreferences.sandbox, true)
  assert.equal(win.first.options.webPreferences.contextIsolation, true)
  assert.equal(win.first.options.webPreferences.nodeIntegration, false)
  assert.equal(win.first.options.webPreferences.nodeIntegrationInSubFrames, true)
})

test('HTML directory inputs, missing files and reused dispatches cannot release upload paths', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 20, frameId: 'fixture-frame', mode: 'selectMultiple' })
  await h.flush()
  const requestId = (await h.run('requests')).result.requests[0].id
  assert.match((await h.run('upload', 'A', { requestId, paths: ['/fixture/missing.txt'] })).error, /missing/)
  h.filesystem.files.set('/fixture/input.txt', 12)
  win.first.onCommand = method => method === 'DOM.describeNode' ? Promise.resolve({ node: { nodeName: 'INPUT', attributes: ['type', 'file', 'webkitdirectory', ''] } }) : undefined
  assert.match((await h.run('upload', 'A', { requestId, paths: ['/fixture/input.txt'] })).error, /directory picker/)
  assert.equal(commandCount(win, 'DOM.setFileInputFiles'), 0)
  win.first.onCommand = method => {
    if (method === 'DOM.describeNode') return Promise.resolve({ node: { nodeName: 'INPUT', attributes: ['type', 'file'] } })
    if (method === 'DOM.setFileInputFiles') return Promise.reject(new Error('uncertain upload error'))
  }
  assert.match((await h.run('upload', 'A', { requestId, paths: ['/fixture/input.txt'] })).error, /uncertain/)
  assert.match((await h.run('upload', 'A', { requestId, paths: ['/fixture/input.txt'] })).error, /stale/)
  assert.equal(commandCount(win, 'DOM.setFileInputFiles'), 1)
})

test('upload requests identify the requesting child frame and never authorize an unknown source', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.onCommand = method => method === 'Page.getFrameTree' ? Promise.resolve({
    frameTree: { frame: { id: 'top', url: 'https://top.example/' }, childFrames: [
      { frame: { id: 'child', url: 'https://upload.example/frame' } },
    ] },
  }) : undefined
  win.first.webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 20, frameId: 'child', mode: 'selectSingle' })
  await h.flush()
  const request = (await h.run('requests')).result.requests[0]
  assert.equal(request.url, 'https://upload.example/frame')
  assert.equal(request.kind, 'upload')
  await h.run('respond', 'A', { requestId: request.id, accept: false })
  win.first.webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 21, frameId: 'unknown', mode: 'selectSingle' })
  await h.flush()
  const blocked = (await h.run('requests')).result.requests[0]
  assert.equal(blocked.kind, 'unsupported')
  assert.match(blocked.message, /来源无法确认/)
  assert.equal((await h.run('upload', 'A', { requestId: blocked.id, paths: ['/fixture/file.txt'] })).ok, false)
  assert.equal(commandCount(win, 'DOM.setFileInputFiles'), 0)
})

test('preload failure closes only the affected window rather than falling back to native dialogs', async t => {
  const h = await createHostHarness(t)
  await h.run('state', 'A')
  await h.run('state', 'B')
  h.natives[0].first.webContents.emit('preload-error', {}, '/fixture/native-preload.cjs', new Error('bridge unavailable'))
  assert.equal(h.natives[0].destroyed, true)
  assert.equal(h.natives[1].destroyed, false)
  assert.equal((await h.run('state', 'B')).ok, true)
})

test('PDF export rejects invalid data, page changes and cancelled output before writing a file', async t => {
  for (const mode of ['invalid', 'navigate', 'cancel']) {
    const h = await createHostHarness(t)
    await h.run('state')
    const win = h.natives[0]
    const gate = deferred()
    win.first.webContents.printToPDF = () => gate.promise
    const id = h.submit('pdf')
    await h.flush()
    if (mode === 'navigate') win.first.webContents.emit('did-start-navigation', { isMainFrame: true })
    if (mode === 'cancel') h.cancel(id)
    gate.resolve(Buffer.from(mode === 'invalid' ? 'invalid' : '%PDF-1.7 fixture'))
    await h.flush()
    assert.equal(h.response(id).ok, false)
    assert.equal(h.filesystem.files.size, 0)
  }
})

test('read returns bounded body text with explicit truncation and preserves click refs', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  h.natives[0].first.page.document.body.innerText = 'a'.repeat(7000)
  const result = (await h.run('read')).result
  assert.equal(result.text, 'a'.repeat(6000))
  assert.equal(result.totalChars, 7000)
  assert.equal(result.returnedChars, 6000)
  assert.equal(result.truncated, true)
  h.natives[0].first.page.document.body.innerText = 'x'.repeat(24001)
  const maximum = (await h.run('read', 'A', { maxChars: 24000 })).result
  assert.equal(maximum.text.length, 24000)
  assert.equal(maximum.totalChars, 24001)
  assert.equal(maximum.truncated, true)
  const id = h.submit('click', 'A', { ref })
  await h.flush()
  h.fire(160)
  await h.flush()
  assert.equal(h.response(id).ok, true)
})

test('read continues long text with an opaque cursor and reconstructs it exactly', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const text = `${'甲'.repeat(5995)}\n${'乙'.repeat(5995)}\n${'丙'.repeat(5995)}\n${'丁'.repeat(5995)}`
  h.natives[0].first.page.document.body.innerText = text
  const pages = []
  let cursor
  for (;;) {
    const result = (await h.run('read', 'A', { cursor })).result
    pages.push(result)
    cursor = result.nextCursor
    if (!cursor) break
  }
  assert.equal(pages.length, 4)
  assert.equal(pages.map(page => page.text).join(''), text)
  assert.equal(pages.at(-1).hasMore, false)
  assert.equal(pages[0].hasMore, true)
  assert.equal(typeof pages[0].nextCursor, 'string')
})

test('read cursors become stale after navigation or selector changes', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  h.natives[0].first.page.document.body.innerText = 'first page content'
  const first = (await h.run('read', 'A', { maxChars: 5 })).result
  h.natives[0].first.webContents.emit('did-start-navigation', { isMainFrame: true })
  assert.match((await h.run('read', 'A', { cursor: first.nextCursor })).error, /stale read cursor/)
  const fresh = (await h.run('read', 'A', { maxChars: 5 })).result
  assert.match((await h.run('read', 'A', { selector: 'main', cursor: fresh.nextCursor })).error, /stale read cursor/)
})

test('read cursor rejects same-length dynamic text changes between pages', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const body = h.natives[0].first.page.document.body
  body.innerText = 'A'.repeat(12000)
  const first = (await h.run('read', 'A', { maxChars: 6000 })).result
  body.innerText = 'B'.repeat(12000)
  assert.match((await h.run('read', 'A', { cursor: first.nextCursor })).error, /page content changed/)
})

test('read cursor preserves surrogate pairs at page boundaries', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  h.natives[0].first.page.document.body.innerText = `${'A'.repeat(5999)}😀B`
  const first = (await h.run('read', 'A', { maxChars: 6000 })).result
  assert.equal(first.returnedChars, 5999)
  assert.equal(first.text.endsWith('😀'), false)
  assert.equal(first.hasMore, true)
  const second = (await h.run('read', 'A', { cursor: first.nextCursor, maxChars: 6000 })).result
  assert.equal(second.text, '😀B')
  assert.equal(second.hasMore, false)
})

test('read cursors are bound to the window generation and reject tampering', async t => {
  const h = await createHostHarness(t)
  await h.run('state', 'A')
  await h.run('state', 'B')
  for (const win of h.natives) win.first.page.document.body.innerText = 'same content'
  const first = (await h.run('read', 'A', { maxChars: 4 })).result
  assert.match((await h.run('read', 'B', { cursor: first.nextCursor })).error, /wrong window/)
  const [payload, signature] = first.nextCursor.split('.')
  const token = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  token.offset++
  const changed = Buffer.from(JSON.stringify(token)).toString('base64url') + '.' + signature
  assert.match((await h.run('read', 'A', { cursor: changed })).error, /invalid cursor/)
  for (const cursor of ['', 'invalid', 'e30.bad', null, 1, 'x'.repeat(4097)]) {
    assert.equal((await h.run('read', 'A', { cursor })).ok, false)
  }
  for (const op of ['close', 'reset']) {
    const old = (await h.run('read', 'A', { maxChars: 4 })).result.nextCursor
    await h.run(op, 'A')
    await h.run('state', 'A')
    h.natives.at(-1).first.page.document.body.innerText = 'same content'
    assert.match((await h.run('read', 'A', { cursor: old })).error, /wrong window/)
  }
})

test('read never returns a non-progressing cursor when the budget splits a surrogate pair', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  h.natives[0].first.page.document.body.innerText = 'A😀B'
  const first = (await h.run('read', 'A', { maxChars: 1 })).result
  assert.equal(first.text, 'A')
  const tooSmall = await h.run('read', 'A', { cursor: first.nextCursor, maxChars: 1 })
  assert.match(tooSmall.error, /increase maxChars to at least 2/)
  const second = (await h.run('read', 'A', { cursor: first.nextCursor, maxChars: 2 })).result
  assert.equal(second.text, '😀')
  const third = (await h.run('read', 'A', { cursor: second.nextCursor, maxChars: 1 })).result
  assert.equal(first.text + second.text + third.text, 'A😀B')
  assert.equal(third.hasMore, false)
  assert.equal(third.nextCursor, undefined)
  h.natives[0].first.page.document.body.innerText = '😀'
  assert.match((await h.run('read', 'A', { maxChars: 1 })).error, /too small/)
})

test('read continues the original region without resending its selector and survives a new snapshot', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  h.natives[0].first.page.element.innerText = 'abcdef'
  const first = (await h.run('read', 'A', { selector: '#field', maxChars: 2 })).result
  await h.run('snapshot')
  const second = (await h.run('read', 'A', { cursor: first.nextCursor, maxChars: 3 })).result
  assert.equal(second.text, 'cde')
  assert.equal(second.offset, 2)
  const last = (await h.run('read', 'A', { cursor: second.nextCursor, selector: '#field' })).result
  assert.equal(last.text, 'f')
  assert.equal(last.hasMore, false)
})

test('eval caps serialized results without disconnecting the shared host and preserves short values', async t => {
  const h = await createHostHarness(t)
  const large = await h.run('eval', 'A', { expression: '"x".repeat(1000001)' })
  assert.equal(large.ok, true)
  assert.equal(large.result.value.length, 1_000_000)
  assert.equal(large.result.truncated, true)
  assert.equal(h.connection.destroyed, false)
  assert.equal((await h.run('state', 'B')).ok, true)
  const emoji = await h.run('eval', 'A', { expression: '"x".repeat(999999) + "😀"' })
  assert.equal(emoji.result.value.length, 999999)
  assert.equal(emoji.result.value.endsWith('😀'), false)
  assert.equal(emoji.result.truncated, true)
  const short = await h.run('eval', 'A', { expression: 'true' })
  assert.deepEqual(short.result, { ok: true, value: 'true', truncated: false })
})

test('read selects a region, handles empty text and avoids splitting surrogate pairs', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const page = h.natives[0].first.page
  const selector = '[data-label="quote\\\\value"]'
  page.element.innerText = 'A😀B'
  page.document.querySelector = value => {
    assert.equal(value, selector)
    return page.element
  }
  const result = (await h.run('read', 'A', { selector, maxChars: 2 })).result
  assert.equal(result.text, 'A')
  assert.equal(result.returnedChars, 1)
  assert.equal(result.totalChars, 4)
  assert.equal(result.truncated, true)
  const exact = (await h.run('read', 'A', { selector, maxChars: 4 })).result
  assert.equal(exact.text, 'A😀B')
  assert.equal(exact.returnedChars, 4)
  assert.equal(exact.truncated, false)
  page.element.innerText = ''
  const empty = (await h.run('read', 'A', { selector })).result
  assert.equal(empty.text, '')
  assert.equal(empty.truncated, false)
})

test('read rejects invalid budgets and selectors instead of silently returning success', async t => {
  const h = await createHostHarness(t)
  for (const maxChars of [0, -1, 24001, 2.5, '100', null]) {
    assert.match((await h.run('read', 'A', { maxChars })).error, /maxChars/)
  }
  for (const selector of ['', ' ', 42, null]) {
    assert.match((await h.run('read', 'A', { selector })).error, /selector/)
  }
  const page = h.natives[0].first.page
  page.document.querySelector = () => null
  assert.match((await h.run('read', 'A', { selector: '#missing' })).error, /did not match/)
  page.document.querySelector = () => { throw new Error('invalid selector') }
  assert.match((await h.run('read', 'A', { selector: '[' })).error, /invalid selector/)
  page.document.querySelector = () => ({ textContent: 'SVG text' })
  assert.match((await h.run('read', 'A', { selector: 'svg' })).error, /HTML element/)
  page.document.body = null
  assert.match((await h.run('read')).error, /no body/)
})

test('read suppresses unrendered roots rather than exposing innerText fallback content', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const root = h.natives[0].first.page.document.body
  root.innerText = 'must not be returned'
  for (const style of [{ display: 'none' }, { visibility: 'hidden' }, { opacity: '0' }]) {
    root.style = style
    assert.equal((await h.run('read')).result.text, '')
  }
  root.style = {}
  root.getClientRects = () => []
  assert.equal((await h.run('read')).result.totalChars, 0)
})

test('read routes per conversation and rejects a result if navigation changed the document', async t => {
  const h = await createHostHarness(t)
  await h.run('state', 'A')
  await h.run('state', 'B')
  h.natives[0].first.page.document.body.innerText = 'page A'
  h.natives[1].first.page.document.body.innerText = 'page B'
  assert.equal((await h.run('read', 'A')).result.text, 'page A')
  assert.equal((await h.run('read', 'B')).result.text, 'page B')
  const gate = deferred()
  const win = h.natives[0]
  win.first.onCommand = method => method === 'Runtime.evaluate' ? gate.promise : undefined
  const id = h.submit('read', 'A')
  await h.flush()
  win.first.webContents.emit('did-start-navigation', { isMainFrame: true })
  gate.resolve({ result: { value: { text: 'old page' } } })
  await h.flush()
  assert.match(h.response(id).error, /page changed during read/)
})

test('host binds loopback, authenticates split frames and rejects extra control connections', async t => {
  const h = await createHostHarness(t, { authenticate: false })
  assert.deepEqual(h.server.bind, { port: 0, host: '127.0.0.1' })
  assert.equal(JSON.parse(h.output[0]).port, 12345)
  h.connection.emit('data', '\r\n{"id":0,"op":"hello","token":"fixture-')
  assert.equal(h.responses.length, 0)
  h.connection.emit('data', 'token"}\n')
  assert.equal(h.response(0).ok, true)
  const extra = h.socket()
  h.accept(extra)
  assert.equal(extra.destroyed, true)
  assert.equal(h.connection.destroyed, false)
  assert.equal(h.natives.length, 0)
})

test('invalid, silent and overlong handshakes cannot displace the control connection', async t => {
  const h = await createHostHarness(t, { authenticate: false })
  h.send({ id: 0, op: 'hello', token: 'wrong' })
  assert.equal(h.connection.destroyed, true)
  const oversized = h.socket()
  h.accept(oversized)
  oversized.emit('data', ' '.repeat(1025))
  assert.equal(oversized.destroyed, true)
  const timedOut = h.socket()
  h.accept(timedOut)
  h.fire(2000)
  assert.equal(timedOut.destroyed, true)
  const silent = h.socket()
  h.accept(silent)
  const legitimate = h.socket()
  h.accept(legitimate)
  legitimate.emit('data', '{"id":0,"op":"hello","token":"fixture-token"}\n{"id":1,"op":"state","conversationId":"A"}\n')
  await h.flush()
  assert.equal(h.response(0).ok, true)
  assert.equal(h.response(1).ok, true)
  assert.equal(silent.destroyed, true)
  assert.equal(h.app.quitCalls, 0)
  legitimate.destroy()
  await h.flush()
  assert.equal(h.app.quitCalls, 1)
  assert.equal(h.natives[0].destroyed, true)
})

test('invalid routing, unknown operations and malformed frames do not allocate windows', async t => {
  const h = await createHostHarness(t)
  h.connection.emit('data', 'not-json\nnull\n[]\n')
  for (const conversationId of [undefined, '', ' ', 1]) {
    const result = await h.run('state', conversationId === undefined ? null : conversationId)
    assert.match(result.error, /conversationId/)
  }
  assert.match((await h.run('unknown')).error, /unknown op/)
  h.send({ id: {}, op: 'state', conversationId: 'A' })
  assert.match(h.responses.at(-1).error, /request id/)
  assert.equal(h.natives.length, 0)
})

test('same-conversation requests queue while a different conversation proceeds', async t => {
  const h = await createHostHarness(t)
  await h.run('state', 'A')
  await h.run('state', 'B')
  const gate = deferred()
  const a = h.natives[0]
  a.first.page.element.focus()
  a.first.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
  const running = h.submit('insertText', 'A', { text: 'blocked' })
  const before = commandCount(a, 'Runtime.evaluate')
  const queued = h.submit('state', 'A')
  const other = h.submit('state', 'B')
  await h.flush()
  assert.equal(h.response(running), undefined)
  assert.equal(h.response(queued), undefined)
  assert.equal(h.response(other).ok, true)
  assert.equal(commandCount(a, 'Runtime.evaluate'), before)
  gate.resolve({})
  await h.flush()
  assert.equal(h.response(running).ok, true)
  assert.equal(h.response(queued).ok, true)
  assert.equal(h.natives.length, 2)
})

test('queued cancellation skips its mutation and cross-conversation cancellation is ignored', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const gate = deferred()
  const win = h.natives[0]
  win.first.page.element.focus()
  win.first.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
  const running = h.submit('insertText', 'A', { text: 'first' })
  const queued = h.submit('insertText', 'A', { text: 'must not run' })
  await h.flush()
  h.cancel(queued, 'B')
  assert.equal(h.response(queued), undefined)
  h.cancel(queued)
  assert.match(h.response(queued).error, /cancelled/)
  gate.resolve({})
  await h.flush()
  assert.equal(h.response(running).ok, true)
  assert.equal(commandCount(win, 'Input.insertText'), 1)
})

test('canceling running CDP reports promptly but retains its queue barrier', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const gate = deferred()
  const win = h.natives[0]
  win.first.page.element.focus()
  win.first.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
  const running = h.submit('insertText', 'A', { text: 'in flight' })
  const queued = h.submit('state')
  await h.flush()
  h.cancel(running)
  assert.match(h.response(running).error, /cancelled/)
  await h.flush()
  assert.equal(h.response(queued), undefined)
  gate.resolve({})
  await h.flush()
  assert.equal(h.response(queued).ok, true)
  assert.equal(h.responses.filter(item => item.id === running).length, 1)
  assert.equal(win.destroyed, false)
})

for (const op of ['close', 'reset']) {
  test(`${op} bypasses blocked queue, rejects old jobs and preserves other conversations`, async t => {
    const h = await createHostHarness(t)
    await h.run('state', 'A')
    await h.run('state', 'B')
    const old = h.natives[0]
    old.first.page.element.focus()
    const gate = deferred()
    old.first.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
    const running = h.submit('insertText', 'A', { text: 'blocked' })
    const queued = h.submit('state', 'A')
    await h.flush()
    const control = await h.run(op, 'A')
    assert.equal(control.ok, true)
    assert.equal(control.result[op === 'close' ? 'closed' : 'reset'], true)
    assert.equal(h.response(running).ok, false)
    assert.equal(h.response(queued).ok, false)
    assert.equal(old.destroyed, true)
    assert.equal(h.natives[1].destroyed, false)
    assert.equal(h.natives.length, 2, 'reset/close must not eagerly replace a window')
    assert.equal((await h.run('state', 'A')).ok, true)
    const fresh = h.windows.get('A')
    gate.resolve({})
    old.emit('closed')
    old.first.webContents.emit('destroyed')
    await h.flush()
    assert.equal(h.windows.get('A'), fresh)
    assert.equal(h.natives[2].destroyed, false)
    assert.equal(h.app.quitCalls, 0)
    assert.equal(h.responses.filter(item => item.id === running).length, 1)
  })
}

test('request deadline cancels without automatically destroying the blocked window', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const gate = deferred()
  h.natives[0].first.page.element.focus()
  h.natives[0].first.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
  const id = h.submit('insertText', 'A', { text: 'blocked' })
  await h.flush()
  h.fire(60000)
  assert.match(h.response(id).error, /deadline exceeded/)
  assert.equal(h.natives[0].destroyed, false)
  gate.resolve({})
  await h.flush()
  assert.equal(h.responses.filter(item => item.id === id).length, 1)
})

test('scoped snapshots restrict output, honor budgets and replace the old global ref map', async t => {
  const h = await createHostHarness(t)
  const oldRef = (await h.run('snapshot')).result.elements[0].ref
  const page = h.natives[0].first.page
  const fields = Array.from({ length: 151 }, (_, index) => Object.assign(Object.create(page.element), {
    id: `field-${index}`, getAttribute: name => name === 'aria-label' ? `field ${index}` : null,
  }))
  const root = { matches: () => false, querySelectorAll: () => fields.slice(100, 103) }
  page.document.querySelectorAll = () => fields
  page.document.querySelector = selector => selector === '#dialog' ? root : null
  const full = (await h.run('snapshot')).result
  assert.equal(full.elements.length, 150)
  assert.equal(full.truncated, true)
  const small = (await h.run('snapshot', 'A', { selector: '#dialog', maxElements: 2, includeSelectors: false })).result
  assert.equal(small.elements.length, 2)
  assert.equal(small.elements[0].label, 'field 100')
  assert.equal(small.elements[0].selector, undefined)
  assert.equal(small.truncated, true)
  assert.equal(small.maxElements, 2)
  assert.equal(small.selector, '#dialog')
  assert.ok(JSON.stringify(small).length < JSON.stringify(full).length / 10)
  assert.match((await h.run('click', 'A', { ref: oldRef })).error, /stale/)
  const id = h.submit('click', 'A', { ref: small.elements[0].ref })
  page.document.elementFromPoint = () => fields[100]
  await h.flush()
  h.fire(160)
  await h.flush()
  assert.equal(h.response(id).ok, true)
  const exact = (await h.run('snapshot', 'A', { selector: '#dialog', maxElements: 3 })).result
  assert.equal(exact.truncated, false)
  const emptyRoot = { matches: () => false, querySelectorAll: () => [] }
  page.document.querySelector = () => emptyRoot
  assert.equal((await h.run('snapshot', 'A', { selector: '#empty' })).result.elements.length, 0)
})

test('snapshot validates options and includes an interactive scope root', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const page = h.natives[0].first.page
  page.element.querySelectorAll = () => []
  const result = (await h.run('snapshot', 'A', { selector: '#field', maxElements: 1 })).result
  assert.equal(result.elements.length, 1)
  assert.equal(result.truncated, false)
  const literal = '[data-label="$&\\\\literal"]'
  page.document.querySelector = selector => {
    assert.equal(selector, literal)
    return page.element
  }
  assert.equal((await h.run('snapshot', 'A', { selector: literal })).ok, true)
  for (const args of [
    { selector: '' }, { selector: null }, { maxElements: 0 }, { maxElements: 151 },
    { maxElements: 1.5 }, { maxElements: '2' }, { includeSelectors: 'false' },
  ]) assert.equal((await h.run('snapshot', 'A', args)).ok, false)
  page.document.querySelector = () => null
  assert.match((await h.run('snapshot', 'A', { selector: '#missing' })).error, /did not match/)
  page.document.querySelector = () => { throw new Error('invalid CSS') }
  assert.match((await h.run('snapshot', 'A', { selector: '[' })).error, /invalid CSS/)
})

test('new snapshot invalidates old refs and refs cannot cross conversation windows', async t => {
  const h = await createHostHarness(t)
  const a = (await h.run('snapshot', 'A')).result.elements[0].ref
  const b = (await h.run('snapshot', 'B')).result.elements[0].ref
  assert.notEqual(a, b)
  const newer = (await h.run('snapshot', 'A')).result.elements[0].ref
  assert.notEqual(a, newer)
  assert.match((await h.run('click', 'A', { ref: a })).error, /stale/)
  assert.match((await h.run('click', 'B', { ref: newer })).error, /stale/)
  assert.equal(commandCount(h.natives[0], 'Input.dispatchMouseEvent'), 0)
  assert.equal(commandCount(h.natives[1], 'Input.dispatchMouseEvent'), 0)
})

for (const event of ['did-start-navigation', 'did-navigate-in-page']) {
  test(`${event} invalidates only the owning main-frame refs`, async t => {
    const h = await createHostHarness(t)
    const a = (await h.run('snapshot', 'A')).result.elements[0].ref
    const b = (await h.run('snapshot', 'B')).result.elements[0].ref
    const contents = h.natives[0].first.webContents
    if (event === 'did-start-navigation') contents.emit(event, { isMainFrame: true })
    else contents.emit(event, {}, 'https://example.test/new', true)
    assert.match((await h.run('click', 'A', { ref: a })).error, /stale/)
    const id = h.submit('click', 'B', { ref: b })
    await h.flush()
    h.fire(160)
    await h.flush()
    assert.equal(h.response(id).ok, true)
  })
}

test('removed DOM node is rejected even if a replacement has the same attributes', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const page = h.natives[0].first.page
  page.element.isConnected = false
  const replacement = { ...page.element, isConnected: true }
  page.document.querySelector = () => replacement
  page.document.querySelectorAll = () => [replacement]
  assert.match((await h.run('click', 'A', { ref })).error, /removed/)
  assert.equal(commandCount(h.natives[0], 'Input.dispatchMouseEvent'), 0)
})

test('hover moves onto a noneditable control without clicking, native focus or ref refresh', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const win = h.natives[0]
  win.first.page.element.tagName = 'BUTTON'
  const result = await h.run('hover', 'A', { ref })
  assert.deepEqual(result.result, { dispatched: true, ref, x: 60, y: 35 })
  const input = win.first.commands.filter(item => item.method === 'Input.dispatchMouseEvent')
  assert.deepEqual(input.map(item => item.params.type), ['mouseMoved'])
  assert.equal(input[0].params.button, undefined)
  assert.equal(win.focusCalls, 0)
  assert.equal(win.first.page.document.activeElement, null)
  const click = h.submit('click', 'A', { ref })
  await h.flush()
  h.fire(160)
  await h.flush()
  assert.equal(h.response(click).ok, true)
})

test('hover rejects stale, foreign, removed and covered targets without mouse input', async t => {
  const h = await createHostHarness(t)
  const old = (await h.run('snapshot', 'A')).result.elements[0].ref
  const ref = (await h.run('snapshot', 'A')).result.elements[0].ref
  await h.run('snapshot', 'B')
  assert.match((await h.run('hover', 'A', { ref: old })).error, /stale/)
  assert.match((await h.run('hover', 'B', { ref })).error, /stale/)
  const page = h.natives[0].first.page
  page.element.isConnected = false
  assert.match((await h.run('hover', 'A', { ref })).error, /removed/)
  page.element.isConnected = true
  page.document.elementFromPoint = () => ({})
  assert.match((await h.run('hover', 'A', { ref })).error, /covered/)
  for (const win of h.natives) assert.equal(commandCount(win, 'Input.dispatchMouseEvent'), 0)
})

test('hover revalidates the target after the cursor overlay before dispatch', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const page = h.natives[0].first.page
  page.document.createElement = () => {
    page.element.isConnected = false
    throw new Error('decoration failed while page changed')
  }
  assert.match((await h.run('hover', 'A', { ref })).error, /removed/)
  assert.equal(commandCount(h.natives[0], 'Input.dispatchMouseEvent'), 0)
})

test('cancellation before hover dispatch prevents pointer movement', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const win = h.natives[0]
  const gate = deferred()
  win.first.onCommand = method => method === 'Runtime.evaluate' ? gate.promise : undefined
  const id = h.submit('hover', 'A', { ref })
  await h.flush()
  h.cancel(id)
  gate.resolve({ result: { value: { x: 60, y: 35 } } })
  await h.flush()
  assert.match(h.response(id).error, /cancelled/)
  assert.equal(commandCount(win, 'Input.dispatchMouseEvent'), 0)
})

test('in-flight hover keeps its window queue barrier and does not block other conversations', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const win = h.natives[0]
  const gate = deferred()
  win.first.onCommand = method => method === 'Input.dispatchMouseEvent' ? gate.promise : undefined
  const id = h.submit('hover', 'A', { ref })
  const queued = h.submit('state', 'A')
  await h.flush()
  assert.equal(win.first.commands.at(-1).params.type, 'mouseMoved')
  h.cancel(id)
  assert.match(h.response(id).error, /cancelled/)
  assert.equal(h.response(queued), undefined)
  assert.equal((await h.run('state', 'B')).ok, true)
  gate.resolve({})
  await h.flush()
  assert.equal(h.response(queued).ok, true)
  assert.equal(commandCount(win, 'Input.dispatchMouseEvent'), 1)
  assert.equal(h.responses.filter(item => item.id === id).length, 1)
})

test('canceling after mouse press still releases the same click without retrying', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const win = h.natives[0]
  const gate = deferred()
  win.first.onCommand = (method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' ? gate.promise : undefined
  const id = h.submit('click', 'A', { ref })
  await h.flush()
  assert.equal(win.first.commands.at(-1).params.type, 'mousePressed')
  h.cancel(id)
  gate.resolve({})
  await h.flush()
  assert.deepEqual(win.first.commands.filter(item => item.method === 'Input.dispatchMouseEvent').map(item => item.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.match(h.response(id).error, /cancelled/)
})

test('canceling during typing delay keeps inserted characters and stops the remainder', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const id = h.submit('type', 'A', { ref, text: 'abc' })
  await h.flush()
  assert.equal(h.natives[0].first.page.element.value, 'a')
  h.cancel(id)
  await h.flush()
  assert.equal(h.natives[0].first.page.element.value, 'a')
  assert.match(h.response(id).error, /cancelled/)
  assert.equal(commandCount(h.natives[0], 'Input.insertText'), 1)
})

test('type and insertText count Unicode code points consistently', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  h.natives[0].first.page.element.focus()
  const text = 'a😀b'
  const inserted = await h.run('insertText', 'A', { text })
  const ref = (await h.run('snapshot', 'A')).result.elements[0].ref
  const id = h.submit('type', 'A', { ref, text })
  for (let i = 0; i < 3; i++) { await h.flush(); h.fire(18) }
  await h.flush()
  h.fire(50)
  await h.flush()
  assert.equal(inserted.result.typed, 3)
  assert.equal(h.response(id).result.typed, 3)
})

test('insertText rejects an absent, read-only or disabled target before sending CDP input', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  const { element, document } = win.first.page
  const insert = () => h.run('insertText', 'A', { text: 'x' })
  document.activeElement = document.body
  assert.match((await insert()).error, /focused editable/)
  element.focus()
  element.readOnly = true
  assert.match((await insert()).error, /focused editable/)
  element.readOnly = false
  element.disabled = true
  assert.match((await insert()).error, /focused editable/)
  element.disabled = false
  win.first.webContents.focusedFrame = null
  assert.match((await insert()).error, /focused editable/)
  assert.equal(commandCount(win, 'Input.insertText'), 0)
})

test('insertText drops a pending focus check after cancellation or a frame switch', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  for (const cancel of [true, false]) {
    const gate = deferred()
    win.first.webContents.focusedFrame = { executeJavaScript: () => gate.promise }
    const id = h.submit('insertText', 'A', { text: 'x' })
    await h.flush()
    if (cancel) h.cancel(id)
    else win.first.webContents.focusedFrame = null
    gate.resolve(true)
    await h.flush()
    assert.match(h.response(id).error, cancel ? /cancelled/ : /focus or page changed/)
  }
  assert.equal(commandCount(win, 'Input.insertText'), 0)
})

test('fast ref input appends 2000 code points in eight bounded CDP chunks without delay', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const win = h.natives[0]
  const text = 'a😀'.repeat(1000)
  win.first.page.element.value = 'prefix'
  const result = await h.run('type', 'A', { ref, text, mode: 'fast' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.result.typed, 2000)
  assert.equal(win.first.page.element.value, 'prefix' + text)
  const chunks = win.first.commands.filter(item => item.method === 'Input.insertText')
  assert.equal(chunks.length, 8)
  for (const chunk of chunks) assert.ok(Array.from(chunk.params.text).length <= 256)
  assert.equal(h.timeouts.size, 0)
  assert.equal(win.focusCalls, 0)
  assert.equal((await h.run('type', 'A', { ref, text: '', mode: 'fast' })).result.typed, 0)
  assert.match((await h.run('type', 'A', { ref, text, mode: 'invalid' })).error, /mode/)
  assert.equal(commandCount(win, 'Input.insertText'), 8)
})

test('fast ref input stops at a focus change and reports confirmed partial progress', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const win = h.natives[0]
  win.first.onCommand = method => {
    if (method === 'Input.insertText') {
      win.first.page.document.activeElement = null
      return Promise.resolve({})
    }
  }
  const result = await h.run('type', 'A', { ref, text: 'x'.repeat(600), mode: 'fast' })
  assert.match(result.error, /input focus changed/)
  assert.match(result.error, /256\/600 Unicode code points acknowledged/)
  assert.equal(win.first.page.element.value, 'x'.repeat(256))
  assert.equal(commandCount(win, 'Input.insertText'), 1)
})

test('fast input cancellation retains the in-flight barrier and never retries the remainder', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const win = h.natives[0]
  const gate = deferred()
  let calls = 0
  win.first.onCommand = method => {
    if (method === 'Input.insertText' && ++calls === 2) return gate.promise
  }
  const id = h.submit('type', 'A', { ref, text: 'x'.repeat(700), mode: 'fast' })
  const queued = h.submit('state')
  await h.flush()
  assert.equal(win.first.page.element.value.length, 256)
  h.cancel(id)
  assert.match(h.response(id).error, /256\/700.*in-flight chunk may still complete/)
  assert.equal(h.response(queued), undefined)
  assert.equal((await h.run('state', 'B')).ok, true)
  gate.resolve({})
  await h.flush()
  assert.equal(h.response(queued).ok, true)
  assert.equal(win.first.page.element.value.length, 512)
  assert.equal(commandCount(win, 'Input.insertText'), 2)
  assert.equal(h.responses.filter(item => item.id === id).length, 1)
})

test('fast input CDP errors retain confirmed progress and do not hide uncertain effects', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const win = h.natives[0]
  let calls = 0
  win.first.onCommand = method => {
    if (method === 'Input.insertText' && ++calls === 2) return Promise.reject(new Error('CDP failure'))
  }
  const result = await h.run('type', 'A', { ref, text: 'x'.repeat(600), mode: 'fast' })
  assert.match(result.error, /CDP failure.*256\/600.*in-flight chunk may still complete/)
  assert.equal(commandCount(win, 'Input.insertText'), 2)
  assert.equal(win.first.page.element.value.length, 256)
})

test('fast input stops after node removal or navigation instead of using a replacement', async t => {
  for (const change of ['removed', 'navigation']) {
    const h = await createHostHarness(t)
    const ref = (await h.run('snapshot')).result.elements[0].ref
    const win = h.natives[0]
    win.first.onCommand = method => {
      if (method === 'Input.insertText') {
        if (change === 'removed') win.first.page.element.isConnected = false
        else win.first.webContents.emit('did-start-navigation', { isMainFrame: true })
        return Promise.resolve({})
      }
    }
    const result = await h.run('type', 'A', { ref, text: 'x'.repeat(700), mode: 'fast' })
    assert.match(result.error, /removed|stale/)
    assert.match(result.error, /256\/700 Unicode code points acknowledged/)
    assert.equal(commandCount(win, 'Input.insertText'), 1)
  }
})

test('scroll dispatches a real wheel event at viewport coordinates and validates bounds', async t => {
  const h = await createHostHarness(t)
  const down = await h.run('scroll', 'A', { deltaY: 600 })
  assert.deepEqual(down.result, { dispatched: true, x: 650, y: 400, deltaX: 0, deltaY: 600 })
  assert.equal(h.natives[0].first.page.wheels.length, 1)
  assert.equal(h.natives[0].first.page.wheels[0].type, 'mouseWheel')
  assert.equal(h.natives[0].first.page.wheels[0].deltaY, 600)
  const horizontal = await h.run('scroll', 'A', { deltaX: -300, deltaY: 0, x: 10, y: 20 })
  assert.deepEqual(horizontal.result, { dispatched: true, x: 10, y: 20, deltaX: -300, deltaY: 0 })
  assert.deepEqual((await h.run('scroll')).result, { dispatched: true, x: 650, y: 400, deltaX: 0, deltaY: 600 })
  for (const args of [{ deltaX: 0, deltaY: 0 }, { deltaY: 1.5 }, { deltaY: 10001 }, { deltaY: -10001 }, { deltaY: 3, x: -1 }, { deltaY: 3, x: 1350 }, { deltaY: 3, y: 801 }]) {
    assert.match((await h.run('scroll', 'A', args)).error, /scroll/)
  }
})

test('canceling before wheel dispatch prevents the scroll side effect', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const gate = deferred()
  const win = h.natives[0]
  win.first.onCommand = method => method === 'Page.getLayoutMetrics' ? gate.promise : undefined
  const id = h.submit('scroll', 'A', { deltaY: 400 })
  await h.flush()
  h.cancel(id)
  gate.resolve({ cssVisualViewport: { clientWidth: 900, clientHeight: 600 } })
  await h.flush()
  assert.match(h.response(id).error, /cancelled/)
  assert.equal(commandCount(win, 'Input.dispatchMouseEvent'), 0)
})

test('key chords map to CDP events with platform-specific Mod and always release keys', async t => {
  for (const [platform, expected] of [['linux', 'Control'], ['win32', 'Control'], ['darwin', 'Meta']]) {
    const h = await createHostHarness(t, { platform })
    const result = await h.run('key', 'A', { key: 'Mod+ArrowLeft' })
    assert.equal(result.ok, true)
    const events = h.natives[0].first.page.keyEvents
    assert.deepEqual(events.map(event => event.type), ['keyDown', 'keyDown', 'keyUp', 'keyUp'])
    assert.deepEqual(events.map(event => event.key), [expected, 'ArrowLeft', 'ArrowLeft', expected])
    assert.equal(events[0].modifiers, events[1].modifiers)
    assert.equal(events[2].modifiers, events[0].modifiers)
    assert.equal(events[3].modifiers, 0)
  }
  const h = await createHostHarness(t)
  assert.deepEqual((await h.run('key', 'A', { key: 'Shift+Tab' })).result, {
    pressed: 'Shift+Tab', key: 'Tab', modifiers: ['Shift'],
  })
  const chord = await h.run('key', 'A', { key: 'Control+Shift+Enter' })
  assert.equal(chord.ok, true)
  const multi = h.natives[0].first.page.keyEvents.slice(-6)
  assert.deepEqual(multi.map(event => [event.type, event.key, event.modifiers]), [
    ['keyDown', 'Control', 2], ['keyDown', 'Shift', 10], ['keyDown', 'Enter', 10],
    ['keyUp', 'Enter', 10], ['keyUp', 'Shift', 2], ['keyUp', 'Control', 0],
  ])
  for (const key of ['', 'Control', 'Shift+Control', 'Shift++Tab', 'Ctrl+Ctrl+Enter', 'Ctrl+Unknown', 'Shift+ ']) {
    assert.match((await h.run('key', 'A', { key })).error, /key/)
  }
})

test('Space and Enter carry text on keydown while shortcut chords and releases carry none', async t => {
  const h = await createHostHarness(t)
  for (const [key, expected] of [['Space', ' '], ['Enter', '\r'], ['Shift+Enter', '\r'], ['Mod+Space', undefined]]) {
    assert.equal((await h.run('key', 'A', { key })).ok, true)
    const events = h.natives[0].first.page.keyEvents.splice(0)
    assert.equal(events.find(event => event.type === 'keyDown' && ['Enter', 'Space'].includes(event.code)).text, expected)
    assert.ok(events.filter(event => event.type === 'keyUp').every(event => !Object.hasOwn(event, 'text')))
  }
})

test('wait reports invalid CSS immediately and retries a destroyed navigation context', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.page.document.querySelector = () => { throw new SyntaxError('invalid CSS selector') }
  assert.match((await h.run('wait', 'A', { selector: '[' })).error, /invalid CSS selector/)
  assert.match((await h.run('wait', 'A', { selector: '  ' })).error, /non-empty CSS selector/)
  win.first.page.document.querySelector = () => win.first.page.element
  let attempts = 0
  win.first.onCommand = method => {
    if (method === 'Runtime.evaluate' && ++attempts === 1) throw new Error('Execution context was destroyed.')
  }
  const id = h.submit('wait', 'A', { selector: '#field' })
  await h.flush()
  assert.equal(h.response(id), undefined)
  h.fire(150)
  await h.flush()
  assert.equal(h.response(id).result.ready, true)
  assert.equal(attempts, 2)
})

test('canceling after keydown emits keyup events before the next same-window operation', async t => {
  const h = await createHostHarness(t)
  const gate = deferred()
  await h.run('state')
  const win = h.natives[0]
  win.first.onCommand = (method, params) => method === 'Input.dispatchKeyEvent' && params.key === 'Enter' && params.type === 'keyDown'
    ? gate.promise
    : undefined
  const id = h.submit('key', 'A', { key: 'Shift+Enter' })
  const queued = h.submit('state', 'A')
  await h.flush()
  const down = win.first.commands.filter(item => item.method === 'Input.dispatchKeyEvent').map(item => item.params)
  assert.deepEqual(down.map(event => [event.type, event.key]), [['keyDown', 'Shift'], ['keyDown', 'Enter']])
  h.cancel(id)
  assert.match(h.response(id).error, /cancelled/)
  gate.resolve({})
  await h.flush()
  assert.deepEqual(win.first.page.keyEvents.map(event => [event.type, event.key]), [
    ['keyDown', 'Shift'], ['keyDown', 'Enter'], ['keyUp', 'Enter'], ['keyUp', 'Shift'],
  ])
  assert.deepEqual(win.first.page.keyEvents.map(event => event.modifiers), [8, 8, 8, 0])
  assert.equal(h.response(queued).ok, true)
  assert.equal(h.responses.filter(item => item.id === id).length, 1)
})

test('key command failures still release active keys and report errors', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.onCommand = (method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key === 'Enter') {
      return Promise.reject(new Error('key transport failed'))
    }
  }
  const result = await h.run('key', 'A', { key: 'Shift+Enter' })
  assert.equal(result.ok, false)
  assert.match(result.error, /key transport failed/)
  assert.deepEqual(win.first.page.keyEvents.map(event => [event.type, event.key]), [
    ['keyDown', 'Shift'], ['keyUp', 'Enter'], ['keyUp', 'Shift'],
  ])
})

test('key release failures remain explicit errors', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.onCommand = (method, params) => method === 'Input.dispatchKeyEvent' && params.type === 'keyUp'
    ? Promise.reject(new Error('key release failed'))
    : undefined
  const result = await h.run('key', 'A', { key: 'Tab' })
  assert.equal(result.ok, false)
  assert.match(result.error, /failed to release 1 key/)
})

test('navigation waits for the new main-frame lifecycle rather than old complete state', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.onCommand = (method, params) => {
    if (method === 'Page.navigate') {
      win.first.page.location.href = params.url
      win.first.webContents.emit('did-start-navigation', { isMainFrame: true, url: params.url })
      return {}
    }
  }
  const url = 'https://example.test/new'
  const id = h.submit('navigate', 'A', { url })
  await h.flush()
  assert.equal(h.response(id), undefined)
  win.first.webContents.emit('did-navigate', {}, url, 200)
  win.first.webContents.emit('did-finish-load')
  await h.flush()
  assert.equal(h.response(id).ok, true)
  assert.equal(h.response(id).result.url, url)
  for (const event of ['did-finish-load', 'did-fail-load', 'did-stop-loading']) {
    assert.equal(win.first.webContents.listenerCount(event), event === 'did-stop-loading' ? 1 : 0)
  }
})

test('navigation HTTP errors reject and remove lifecycle listeners', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.onCommand = (method, params) => {
    if (method === 'Page.navigate') {
      win.first.webContents.emit('did-start-navigation', { isMainFrame: true, url: params.url })
      return {}
    }
  }
  const url = 'https://example.test/missing'
  const id = h.submit('navigate', 'A', { url })
  await h.flush()
  win.first.webContents.emit('did-navigate', {}, url, 404)
  win.first.webContents.emit('did-finish-load')
  await h.flush()
  assert.match(h.response(id).error, /HTTP 404/)
  assert.equal(win.first.webContents.listenerCount('did-finish-load'), 0)
})

test('timed-out navigation keeps the queue barrier until the load actually settles', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.first.onCommand = (method, params) => {
    if (method === 'Page.navigate') {
      win.first.webContents.emit('did-start-navigation', { isMainFrame: true, url: params.url })
      return {}
    }
  }
  const id = h.submit('navigate', 'A', { url: 'https://example.test/slow' })
  const queued = h.submit('state')
  await h.flush()
  h.fire(15000)
  await h.flush()
  assert.match(h.response(id).error, /navigation timed out/)
  assert.equal(h.response(queued), undefined)
  assert.equal(win.destroyed, false)
  win.first.webContents.emit('did-finish-load')
  await h.flush()
  assert.equal(h.response(queued).ok, true)
  assert.equal(h.responses.filter(item => item.id === id).length, 1)
  assert.equal(win.first.webContents.listenerCount('did-finish-load'), 0)
})

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`background initialization never focuses a native window (${platform} simulation)`, async t => {
    const h = await createHostHarness(t, { platform })
    assert.equal((await h.run('state')).ok, true)
    const win = h.natives[0]
    assert.equal(win.focusCalls, 0)
    assert.equal(win.options.focusable, platform === 'win32')
    const initialLoad = win.lifecycleCalls.find(call => call.action === 'loadURL')
    assert.equal(initialLoad.focusable, platform === 'win32')
    assert.equal(initialLoad.mouseIgnored, true)
    const initialShow = win.lifecycleCalls.find(call => call.action === 'showInactive')
    assert.equal(initialShow.focusable, platform === 'win32')
    assert.equal(initialShow.opacity, platform === 'win32' ? 1 : 0)
    assert.equal(win.first.options.webPreferences.session, h.defaultSession)
    assert.equal(win.first.options.webPreferences.backgroundThrottling, false)
    assert.equal(win.visible, true)
    assert.ok(win.getBounds().x + win.getBounds().width < 0)
    assert.equal(win.opacity, platform === 'win32' ? 1 : 0)
    if (platform === 'win32') {
      win.emit('close', { preventDefault() {} })
      await h.flush()
      assert.equal(win.destroyed, true)
      assert.equal(h.app.quitCalls, 1)
      assert.equal(h.defaultSession.flushes, 1)
    } else {
      win.emit('close', { preventDefault() {} })
      assert.equal(win.destroyed, false)
      assert.equal(h.app.quitCalls, 0)
    }
  })
}

test('macOS returning a focused inspection window to background releases native keyboard focus', async t => {
  const h = await createHostHarness(t, { platform: 'darwin' })
  await h.run('state')
  const win = h.natives[0]
  assert.equal((await h.run('windowShow')).result.shown, true)
  assert.equal(win.focused, true)
  assert.equal(win.focusable, true)
  assert.equal(win.mouseIgnored, false)
  const before = win.lifecycleCalls.length
  assert.equal((await h.run('windowHide')).result.hidden, true)
  assert.equal(win.focused, false)
  assert.equal(win.focusable, false)
  assert.equal(win.mouseIgnored, true)
  assert.equal(win.opacity, 0)
  assert.equal(win.lifecycleCalls[before].action, 'blur')
  assert.equal((await h.run('windowShow')).result.shown, true, 'explicit inspection must remain available')
})

for (const platform of ['darwin', 'linux']) {
  test(`minimize recovery disarms a focusable inspection window before native restore (${platform})`, async t => {
    const h = await createHostHarness(t, { platform })
    await h.run('state')
    await h.run('windowShow')
    const win = h.natives[0]
    const focusCalls = win.focusCalls
    win.emit('minimize')
    h.fire(50)
    await h.flush()
    const restored = win.lifecycleCalls.find(call => call.action === 'restore')
    assert.equal(restored.focusable, false)
    assert.equal(restored.opacity, 0)
    assert.equal(win.focusCalls, focusCalls, 'automatic recovery must not invoke a focusable native restore')
    assert.equal(win.focused, false)
    assert.equal(win.mouseIgnored, true)
  })
}

test('ordinary CDP input does not activate an app or re-enable native window focus on macOS', async t => {
  const h = await createHostHarness(t, { platform: 'darwin' })
  const ref = (await h.run('snapshot')).result.elements[0].ref
  await h.run('hover', 'A', { ref })
  await h.run('type', 'A', { ref, text: 'background input', mode: 'fast' })
  await h.run('key', 'A', { key: 'Tab' })
  await h.run('scroll')
  const win = h.natives[0]
  assert.equal(win.focusCalls, 0)
  assert.equal(h.app.focusCalls, 0)
  assert.equal(win.focused, false)
  assert.equal(win.focusable, false)
  assert.equal(win.mouseIgnored, true)
  assert.equal(win.lifecycleCalls.some(call => call.action === 'focusable' && call.value === true), false)
})
