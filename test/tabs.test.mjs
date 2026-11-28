import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostHarness, deferred } from './helpers/host-harness.mjs'

test('tab operations are conversation scoped and closing the last tab preserves the session', async t => {
  const h = await createHostHarness(t, { env: { BROWSER_USE_SESSION_MODE: 'isolated' } })
  assert.deepEqual((await h.run('tabs', 'A', { action: 'list' })).result.tabs, [])
  assert.equal((await h.run('state', 'B', { tabId: 'missing' })).ok, false)
  assert.equal(h.natives.length, 0)
  const first = (await h.run('tabs', 'A', { action: 'new' })).result
  const second = (await h.run('tabs', 'A', { action: 'new' })).result
  const win = h.natives[0]
  assert.equal(first.tabs.length, 1)
  assert.equal(second.tabs.length, 2)
  assert.equal(win.views[0].options.webPreferences.session, win.views[1].options.webPreferences.session)
  assert.equal((await h.run('tabs', 'B', { action: 'select', tabId: first.activeTabId })).ok, false)
  assert.equal((await h.run('tabs', 'A', { action: 'select', tabId: first.activeTabId })).result.activeTabId, first.activeTabId)
  await h.run('tabs', 'A', { action: 'close', tabId: second.activeTabId })
  const blank = (await h.run('tabs', 'A', { action: 'close', tabId: first.activeTabId })).result
  assert.equal(blank.tabs.length, 1)
  assert.notEqual(blank.activeTabId, first.activeTabId)
  assert.equal((await h.run('state', 'A', { tabId: second.activeTabId })).ok, false)
  assert.equal(win.first.options.webPreferences.session.cleanups, 0)
  assert.equal(win.views.length, 1)
  assert.equal(win.focusCalls, 0)
  assert.equal(h.natives.length, 1)
})

test('implicit page target is captured before waiting and close cancels only its tab', async t => {
  const h = await createHostHarness(t)
  const first = (await h.run('tabs', 'A', { action: 'new' })).result.activeTabId
  const page = h.natives[0].first
  const gate = deferred()
  page.onCommand = method => method === 'Runtime.evaluate' ? gate.promise : undefined
  const busy = h.submit('eval', 'A', { expression: '1' })
  const follows = h.submit('state')
  const second = (await h.run('tabs', 'A', { action: 'new' })).result.activeTabId
  assert.equal((await h.run('state')).ok, true)
  assert.equal(h.response(follows), undefined)
  page.page.location.href = 'https://first.test/'
  page.onCommand = undefined
  gate.resolve({ result: { value: 1 } })
  await h.flush()
  assert.equal(h.response(busy).ok, true)
  assert.equal(h.response(follows).result.url, 'https://first.test/')

  const stuck = deferred()
  page.onCommand = method => method === 'Runtime.evaluate' ? stuck.promise : undefined
  const running = h.submit('eval', 'A', { tabId: first, expression: '2' })
  const queued = h.submit('state', 'A', { tabId: first })
  await h.flush()
  await h.run('tabs', 'A', { action: 'close', tabId: first })
  assert.match(h.response(running).error, /tab closed/)
  assert.match(h.response(queued).error, /tab closed/)
  assert.equal((await h.run('state', 'A', { tabId: second })).ok, true)
  stuck.resolve({ result: { value: 2 } })
})

test('refs, read cursors and pending approvals stay with their originating tab', async t => {
  const h = await createHostHarness(t)
  const first = (await h.run('tabs', 'A', { action: 'new' })).result.activeTabId
  const view = h.natives[0].first
  view.page.document.body.innerText = 'article text'
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const cursor = (await h.run('read', 'A', { maxChars: 2 })).result.nextCursor
  const event = { sender: view.webContents, senderFrame: { url: 'https://first.test/' } }
  h.ipcMain.emit('dsh-browser-native-ui', event, { kind: 'confirm', message: 'Continue?' })
  const second = (await h.run('tabs', 'A', { action: 'new' })).result.activeTabId
  const { requests: [request] } = (await h.run('requests')).result
  assert.equal(request.tabId, first)
  assert.deepEqual((await h.run('requests', 'A', { tabId: second })).result.requests, [])
  assert.equal((await h.run('respond', 'A', { requestId: request.id, tabId: second, accept: true })).ok, false)
  assert.equal(event.returnValue, undefined)
  assert.equal((await h.run('respond', 'A', { requestId: request.id, accept: false })).ok, true)
  assert.equal(event.returnValue.accepted, false)
  await h.run('snapshot')
  assert.equal((await h.run('hover', 'A', { ref })).ok, false)
  assert.equal((await h.run('read', 'A', { cursor })).ok, false)
  assert.equal((await h.run('read', 'A', { tabId: first, cursor })).result.text, 'ticle text')
  assert.equal((await h.run('hover', 'A', { tabId: first, ref })).ok, true)
})

test('only the local toolbar main frame can route address entry and tab controls', async t => {
  const h = await createHostHarness(t)
  const tabId = (await h.run('tabs', 'A', { action: 'new' })).result.activeTabId
  const win = h.natives[0]
  const [handle] = h.ipcMain.listeners('dsh:toolbar')
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  assert.throws(() => handle({ ...event, senderFrame: {} }, 'list'), /unknown toolbar/)
  assert.throws(() => handle({ sender: win.first.webContents, senderFrame: win.first.webContents.mainFrame }, 'list'), /unknown toolbar/)
  assert.equal(win.options.webPreferences.partition, 'dsh-browser-toolbar')
  for (const value of ['javascript:alert(1)', 'file:///tmp/test', ' ', 'not a url']) {
    await assert.rejects(handle(event, 'navigate', tabId, value))
  }
  win.first.onCommand = (method, { url }) => {
    if (method !== 'Page.navigate') return
    win.first.page.location.href = url
    win.first.webContents.emit('did-start-navigation', { isMainFrame: true, url })
    win.first.webContents.emit('did-finish-load')
  }
  await handle(event, 'navigate', tabId, 'example.test/path')
  assert.equal(win.first.webContents.getURL(), 'https://example.test/path')
  await handle(event, 'navigate', tabId, 'localhost:8000/path')
  assert.equal(win.first.webContents.getURL(), 'https://localhost:8000/path')
  assert.equal(win.first.webContents.openHandler({ url: 'file:///tmp/test' }).action, 'deny')
  const popup = win.first.webContents.openHandler({ url: 'https://example.test/' })
  assert.equal(popup.outlivesOpener, true)
  assert.equal(win.webContents.openHandler().action, 'deny')
})

test('window show can be cancelled while the first window is starting', async t => {
  const h = await createHostHarness(t)
  const id = h.submit('windowShow')
  h.cancel(id)
  await h.flush()
  assert.match(h.response(id).error, /cancelled/)
  assert.equal(h.natives[0].focusCalls, 0)
})

test('new returns a usable tab or reports the initialization failure', async t => {
  const h = await createHostHarness(t)
  const original = (await h.run('tabs', 'A', { action: 'new' })).result.activeTabId
  const gate = deferred()
  const id = h.submit('tabs', 'A', { action: 'new' })
  h.natives[0].views.at(-1).onCommand = method => method === 'Page.enable' ? gate.promise : undefined
  await h.flush()
  assert.equal(h.response(id), undefined)
  gate.reject(new Error('page initialization failed'))
  await h.flush()
  assert.match(h.response(id).error, /page initialization failed/)
  assert.equal((await h.run('tabs', 'A', { action: 'list' })).result.activeTabId, original)
})

test('manual navigation waits for the captured tab queue and preserves another selected tab', async t => {
  const h = await createHostHarness(t)
  const tabId = (await h.run('tabs', 'A', { action: 'new' })).result.activeTabId
  const win = h.natives[0]
  const gate = deferred()
  win.first.onCommand = method => method === 'Runtime.evaluate' ? gate.promise : undefined
  const busy = h.submit('eval', 'A', { expression: '1' })
  await h.flush()
  const [handle] = h.ipcMain.listeners('dsh:toolbar')
  const navigation = handle({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'navigate', tabId, 'first.test')
  const selected = (await h.run('tabs', 'A', { action: 'new' })).result.activeTabId
  assert.equal(win.first.commands.some(c => c.method === 'Page.navigate'), false)
  const command = deferred()
  win.first.onCommand = (method, { url }) => {
    if (method !== 'Page.navigate') return
    win.first.webContents.emit('did-start-navigation', { isMainFrame: true, url })
    return command.promise
  }
  gate.resolve({ result: { value: 1 } })
  await h.flush()
  assert.equal(h.response(busy).ok, true)
  const timeout = assert.rejects(navigation, /timed out/)
  h.fire(15_000)
  await timeout
  const queued = h.submit('state', 'A', { tabId })
  await h.flush()
  assert.equal(h.response(queued), undefined)
  command.reject(new Error('CDP command ended while navigation was still loading'))
  await h.flush()
  assert.equal(h.response(queued), undefined)
  win.first.webContents.emit('did-finish-load')
  await h.flush()
  assert.equal(h.response(queued).ok, true)
  assert.equal((await h.run('tabs', 'A', { action: 'list' })).result.activeTabId, selected)
})
