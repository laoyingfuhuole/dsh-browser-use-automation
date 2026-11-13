import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostHarness, deferred } from './helpers/host-harness.mjs'

const commandCount = (win, method) => win.commands.filter(command => command.method === method).length

test('read returns bounded body text with explicit truncation and preserves click refs', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  h.natives[0].page.document.body.innerText = 'a'.repeat(7000)
  const result = (await h.run('read')).result
  assert.equal(result.text, 'a'.repeat(6000))
  assert.equal(result.totalChars, 7000)
  assert.equal(result.returnedChars, 6000)
  assert.equal(result.truncated, true)
  h.natives[0].page.document.body.innerText = 'x'.repeat(24001)
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
  h.natives[0].page.document.body.innerText = text
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
  h.natives[0].page.document.body.innerText = 'first page content'
  const first = (await h.run('read', 'A', { maxChars: 5 })).result
  h.natives[0].webContents.emit('did-start-navigation', { isMainFrame: true })
  assert.match((await h.run('read', 'A', { cursor: first.nextCursor })).error, /stale read cursor/)
  const fresh = (await h.run('read', 'A', { maxChars: 5 })).result
  assert.match((await h.run('read', 'A', { selector: 'main', cursor: fresh.nextCursor })).error, /stale read cursor/)
})

test('read cursor rejects same-length dynamic text changes between pages', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const body = h.natives[0].page.document.body
  body.innerText = 'A'.repeat(12000)
  const first = (await h.run('read', 'A', { maxChars: 6000 })).result
  body.innerText = 'B'.repeat(12000)
  assert.match((await h.run('read', 'A', { cursor: first.nextCursor })).error, /page content changed/)
})

test('read cursor preserves surrogate pairs at page boundaries', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  h.natives[0].page.document.body.innerText = `${'A'.repeat(5999)}😀B`
  const first = (await h.run('read', 'A', { maxChars: 6000 })).result
  assert.equal(first.returnedChars, 5999)
  assert.equal(first.text.endsWith('😀'), false)
  assert.equal(first.hasMore, true)
  const second = (await h.run('read', 'A', { cursor: first.nextCursor, maxChars: 6000 })).result
  assert.equal(second.text, '😀B')
  assert.equal(second.hasMore, false)
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
  const page = h.natives[0].page
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
  const page = h.natives[0].page
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
  const root = h.natives[0].page.document.body
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
  h.natives[0].page.document.body.innerText = 'page A'
  h.natives[1].page.document.body.innerText = 'page B'
  assert.equal((await h.run('read', 'A')).result.text, 'page A')
  assert.equal((await h.run('read', 'B')).result.text, 'page B')
  const gate = deferred()
  const win = h.natives[0]
  win.onCommand = method => method === 'Runtime.evaluate' ? gate.promise : undefined
  const id = h.submit('read', 'A')
  await h.flush()
  win.webContents.emit('did-start-navigation', { isMainFrame: true })
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

test('wrong token closes connection without creating a window', async t => {
  const h = await createHostHarness(t, { authenticate: false })
  h.send({ id: 0, op: 'hello', token: 'wrong' })
  await h.flush()
  assert.equal(h.connection.destroyed, true)
  assert.equal(h.natives.length, 0)
  assert.equal(h.app.quitCalls, 1)
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
  a.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
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
  win.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
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
  win.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
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
    const gate = deferred()
    old.onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
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
    old.webContents.emit('destroyed')
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
  h.natives[0].onCommand = method => method === 'Input.insertText' ? gate.promise : undefined
  const id = h.submit('insertText', 'A', { text: 'blocked' })
  await h.flush()
  h.fire(60000)
  assert.match(h.response(id).error, /deadline exceeded/)
  assert.equal(h.natives[0].destroyed, false)
  gate.resolve({})
  await h.flush()
  assert.equal(h.responses.filter(item => item.id === id).length, 1)
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
    const contents = h.natives[0].webContents
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
  const page = h.natives[0].page
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
  win.page.element.tagName = 'BUTTON'
  const result = await h.run('hover', 'A', { ref })
  assert.deepEqual(result.result, { dispatched: true, ref, x: 60, y: 35 })
  const input = win.commands.filter(item => item.method === 'Input.dispatchMouseEvent')
  assert.deepEqual(input.map(item => item.params.type), ['mouseMoved'])
  assert.equal(input[0].params.button, undefined)
  assert.equal(win.focusCalls, 0)
  assert.equal(win.page.document.activeElement, null)
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
  const page = h.natives[0].page
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
  const page = h.natives[0].page
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
  win.onCommand = method => method === 'Runtime.evaluate' ? gate.promise : undefined
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
  win.onCommand = method => method === 'Input.dispatchMouseEvent' ? gate.promise : undefined
  const id = h.submit('hover', 'A', { ref })
  const queued = h.submit('state', 'A')
  await h.flush()
  assert.equal(win.commands.at(-1).params.type, 'mouseMoved')
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
  win.onCommand = (method, params) => method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' ? gate.promise : undefined
  const id = h.submit('click', 'A', { ref })
  await h.flush()
  assert.equal(win.commands.at(-1).params.type, 'mousePressed')
  h.cancel(id)
  gate.resolve({})
  await h.flush()
  assert.deepEqual(win.commands.filter(item => item.method === 'Input.dispatchMouseEvent').map(item => item.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.match(h.response(id).error, /cancelled/)
})

test('canceling during typing delay keeps inserted characters and stops the remainder', async t => {
  const h = await createHostHarness(t)
  const ref = (await h.run('snapshot')).result.elements[0].ref
  const id = h.submit('type', 'A', { ref, text: 'abc' })
  await h.flush()
  assert.equal(h.natives[0].page.element.value, 'a')
  h.cancel(id)
  await h.flush()
  assert.equal(h.natives[0].page.element.value, 'a')
  assert.match(h.response(id).error, /cancelled/)
  assert.equal(commandCount(h.natives[0], 'Input.insertText'), 1)
})

test('type and insertText count Unicode code points consistently', async t => {
  const h = await createHostHarness(t)
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

test('scroll dispatches a real wheel event at viewport coordinates and validates bounds', async t => {
  const h = await createHostHarness(t)
  const down = await h.run('scroll', 'A', { deltaY: 600 })
  assert.deepEqual(down.result, { dispatched: true, x: 650, y: 400, deltaX: 0, deltaY: 600 })
  assert.equal(h.natives[0].page.wheels.length, 1)
  assert.equal(h.natives[0].page.wheels[0].type, 'mouseWheel')
  assert.equal(h.natives[0].page.wheels[0].deltaY, 600)
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
  win.onCommand = method => method === 'Page.getLayoutMetrics' ? gate.promise : undefined
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
    const events = h.natives[0].page.keyEvents
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
  const multi = h.natives[0].page.keyEvents.slice(-6)
  assert.deepEqual(multi.map(event => [event.type, event.key, event.modifiers]), [
    ['keyDown', 'Control', 2], ['keyDown', 'Shift', 10], ['keyDown', 'Enter', 10],
    ['keyUp', 'Enter', 10], ['keyUp', 'Shift', 2], ['keyUp', 'Control', 0],
  ])
  for (const key of ['', 'Control', 'Shift+Control', 'Shift++Tab', 'Ctrl+Ctrl+Enter', 'Ctrl+Unknown', 'Shift+ ']) {
    assert.match((await h.run('key', 'A', { key })).error, /key/)
  }
})

test('canceling after keydown emits keyup events before the next same-window operation', async t => {
  const h = await createHostHarness(t)
  const gate = deferred()
  await h.run('state')
  const win = h.natives[0]
  win.onCommand = (method, params) => method === 'Input.dispatchKeyEvent' && params.key === 'Enter' && params.type === 'keyDown'
    ? gate.promise
    : undefined
  const id = h.submit('key', 'A', { key: 'Shift+Enter' })
  const queued = h.submit('state', 'A')
  await h.flush()
  const down = win.commands.filter(item => item.method === 'Input.dispatchKeyEvent').map(item => item.params)
  assert.deepEqual(down.map(event => [event.type, event.key]), [['keyDown', 'Shift'], ['keyDown', 'Enter']])
  h.cancel(id)
  assert.match(h.response(id).error, /cancelled/)
  gate.resolve({})
  await h.flush()
  assert.deepEqual(win.page.keyEvents.map(event => [event.type, event.key]), [
    ['keyDown', 'Shift'], ['keyDown', 'Enter'], ['keyUp', 'Enter'], ['keyUp', 'Shift'],
  ])
  assert.deepEqual(win.page.keyEvents.map(event => event.modifiers), [8, 8, 8, 0])
  assert.equal(h.response(queued).ok, true)
  assert.equal(h.responses.filter(item => item.id === id).length, 1)
})

test('key command failures still release active keys and report errors', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.onCommand = (method, params) => {
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key === 'Enter') {
      return Promise.reject(new Error('key transport failed'))
    }
  }
  const result = await h.run('key', 'A', { key: 'Shift+Enter' })
  assert.equal(result.ok, false)
  assert.match(result.error, /key transport failed/)
  assert.deepEqual(win.page.keyEvents.map(event => [event.type, event.key]), [
    ['keyDown', 'Shift'], ['keyUp', 'Enter'], ['keyUp', 'Shift'],
  ])
})

test('key release failures remain explicit errors', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.onCommand = (method, params) => method === 'Input.dispatchKeyEvent' && params.type === 'keyUp'
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
  win.onCommand = (method, params) => {
    if (method === 'Page.navigate') {
      win.page.location.href = params.url
      win.webContents.emit('did-start-navigation', { isMainFrame: true, url: params.url })
      return {}
    }
  }
  const url = 'https://example.test/new'
  const id = h.submit('navigate', 'A', { url })
  await h.flush()
  assert.equal(h.response(id), undefined)
  win.webContents.emit('did-navigate', {}, url, 200)
  win.webContents.emit('did-finish-load')
  await h.flush()
  assert.equal(h.response(id).ok, true)
  assert.equal(h.response(id).result.url, url)
  for (const event of ['did-finish-load', 'did-fail-load', 'did-stop-loading']) {
    assert.equal(win.webContents.listenerCount(event), 0)
  }
})

test('navigation HTTP errors reject and remove lifecycle listeners', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.onCommand = (method, params) => {
    if (method === 'Page.navigate') {
      win.webContents.emit('did-start-navigation', { isMainFrame: true, url: params.url })
      return {}
    }
  }
  const url = 'https://example.test/missing'
  const id = h.submit('navigate', 'A', { url })
  await h.flush()
  win.webContents.emit('did-navigate', {}, url, 404)
  win.webContents.emit('did-finish-load')
  await h.flush()
  assert.match(h.response(id).error, /HTTP 404/)
  assert.equal(win.webContents.listenerCount('did-finish-load'), 0)
})

test('timed-out navigation keeps the queue barrier until the load actually settles', async t => {
  const h = await createHostHarness(t)
  await h.run('state')
  const win = h.natives[0]
  win.onCommand = (method, params) => {
    if (method === 'Page.navigate') {
      win.webContents.emit('did-start-navigation', { isMainFrame: true, url: params.url })
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
  win.webContents.emit('did-finish-load')
  await h.flush()
  assert.equal(h.response(queued).ok, true)
  assert.equal(h.responses.filter(item => item.id === id).length, 1)
  assert.equal(win.webContents.listenerCount('did-finish-load'), 0)
})

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`background initialization never focuses a native window (${platform} simulation)`, async t => {
    const h = await createHostHarness(t, { platform })
    assert.equal((await h.run('state')).ok, true)
    const win = h.natives[0]
    assert.equal(win.focusCalls, 0)
    assert.equal(win.options.webPreferences.session, h.defaultSession)
    assert.equal(win.options.webPreferences.backgroundThrottling, false)
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
