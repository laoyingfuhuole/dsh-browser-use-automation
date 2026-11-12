import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { createClientHarness } from './helpers/client-harness.mjs'

const message = (id, op = 'state', conversationId = 'A') => ({ id, op, conversationId })
const respond = (socket, id, result = {}) => socket.emit('data', JSON.stringify({ id, ok: true, result }) + '\n')

test('construction is lazy and invalid or pre-aborted calls never start a host', async t => {
  const h = await createClientHarness(t)
  assert.equal(h.children.length, 0)
  for (const conversationId of [undefined, null, '', '   ', 42]) {
    await assert.rejects(h.client.call('state', { conversationId }), /conversationId/)
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(h.client.call('state', { conversationId: 'A' }, controller.signal), /aborted/)
  assert.equal(h.children.length, 0)
})

test('concurrent calls share startup and wait for hello, preserving captured routing', async t => {
  const h = await createClientHarness(t)
  const payload = { conversationId: 'A', op: 'close', id: 999 }
  const a = h.client.call('state', payload)
  const b = h.client.call('state', { conversationId: 'B' })
  payload.conversationId = 'changed'
  assert.equal(h.children.length, 1)
  const child = h.children[0]
  assert.equal(child.options.env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(child.options.env.BROWSER_USE_WIDTH, '1200')
  const socket = await h.connect()
  assert.deepEqual(socket.writes.map(item => item.op), ['hello'])
  assert.equal(socket.writes[0].token, child.options.env.BROWSER_USE_TOKEN)
  respond(socket, 0)
  await h.flush()
  assert.deepEqual(socket.writes.slice(1).map(item => [item.id, item.op, item.conversationId]), [[1, 'state', 'A'], [2, 'state', 'B']])
  respond(socket, 2, 'B')
  respond(socket, 1, 'A')
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B'])
  assert.equal(h.client.pending.size, 0)
  assert.equal(h.timers.size, 0)
})

test('canceling one startup waiter does not cancel shared startup or send its operation', async t => {
  const h = await createClientHarness(t)
  const controller = new AbortController()
  const a = h.client.call('click', { conversationId: 'A' }, controller.signal)
  const rejected = assert.rejects(a, /aborted/)
  const b = h.client.call('state', { conversationId: 'B' })
  controller.abort()
  await rejected
  const socket = await h.connect()
  respond(socket, 0)
  await h.flush()
  assert.deepEqual(socket.writes.map(item => item.op), ['hello', 'state'])
  respond(socket, 1, 'B')
  assert.equal(await b, 'B')
  assert.equal(h.children[0].kills.length, 0)
})

for (const line of ['not-json\n', '{"port":0}\n', '{"port":65536}\n', '{"port":"123"}\n']) {
  test(`invalid ready output fails fast: ${JSON.stringify(line)}`, async t => {
    const h = await createClientHarness(t)
    const rejected = assert.rejects(h.client.ensureStarted(), /invalid ready line/)
    h.children[0].stdout.emit('data', line)
    await rejected
    assert.equal(h.sockets.length, 0)
    assert.deepEqual(h.children[0].kills, ['SIGTERM'])
    assert.equal(h.children[0].stdout.listenerCount('data'), 0)
    assert.equal(h.timers.size, 0)
  })
}

test('ready output has a size limit and readiness timeout releases startup resources', async t => {
  for (const oversized of [true, false]) {
    const h = await createClientHarness(t)
    const rejected = assert.rejects(h.client.ensureStarted(), oversized ? /exceeded/ : /did not become ready/)
    if (oversized) h.children[0].stdout.emit('data', ' '.repeat(65537))
    else h.expire()
    await rejected
    assert.equal(h.client.starting, null)
    assert.equal(h.timers.size, 0)
    assert.equal(h.children[0].stdout.listenerCount('data'), 0)
  }
})

test('failed authentication rejects callers and never sends page operations', async t => {
  const h = await createClientHarness(t)
  const rejected = assert.rejects(h.client.call('click', { conversationId: 'A' }), /bad token/)
  const socket = await h.connect()
  socket.emit('data', '{"id":0,"ok":false,"error":"bad token"}\n')
  await rejected
  assert.deepEqual(socket.writes.map(item => item.op), ['hello'])
  assert.equal(socket.destroyed, true)
  assert.equal(h.timers.size, 0)
})

test('split and coalesced responses route by id, ignoring invalid and unknown frames', async t => {
  const h = await createClientHarness(t)
  const socket = await h.ready()
  const a = h.client.request(message(1), 1000)
  const b = h.client.request(message(2), 1000)
  socket.emit('data', '\nnot-json\nnull\n42\n{"id":999,"ok":true}\n{"id":2,"ok":true,"res')
  assert.equal(h.client.pending.size, 2)
  socket.emit('data', 'ult":"second"}\n{"id":1,"ok":true,"result":"first"}\n')
  assert.deepEqual(await Promise.all([a, b]), ['first', 'second'])
  assert.equal(h.client.pending.size, 0)
  assert.equal(h.timers.size, 0)
})

test('RPC error is propagated and does not dispose a healthy connection', async t => {
  const h = await createClientHarness(t)
  const socket = await h.ready()
  const rejected = assert.rejects(h.client.request(message(1), 1000), /page failure/)
  socket.emit('data', '{"id":1,"ok":false,"error":"page failure"}\n')
  await rejected
  assert.equal(socket.destroyed, false)
  assert.equal(h.client.pending.size, 0)
  assert.equal(h.timers.size, 0)
})

test('sent cancellation notifies once, clears listeners, ignores late response and never retries', async t => {
  const h = await createClientHarness(t)
  const socket = await h.ready()
  const controller = new AbortController()
  const rejected = assert.rejects(h.client.request(message(1, 'click'), 1000, controller.signal), /aborted/)
  controller.abort()
  await rejected
  respond(socket, 1, 'late')
  assert.deepEqual(socket.writes.map(item => item.op), ['hello', 'click', 'cancel'])
  assert.equal(socket.writes[2].requestId, 1)
  assert.equal(socket.writes[2].conversationId, 'A')
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(h.client.pending.size, 0)
  assert.equal(h.timers.size, 0)
  assert.equal(socket.destroyed, false)
})

test('request timeout notifies host without closing or automatically retrying mutations', async t => {
  const h = await createClientHarness(t)
  const socket = await h.ready()
  const rejected = assert.rejects(h.client.request(message(1, 'type'), 10), /timed out after 10ms on type/)
  h.expire()
  await rejected
  respond(socket, 1)
  assert.deepEqual(socket.writes.map(item => item.op), ['hello', 'type', 'cancel'])
  assert.equal(socket.destroyed, false)
  assert.equal(h.client.pending.size, 0)
})

test('cancellation during serialization sends neither the original operation nor cancel', async t => {
  const h = await createClientHarness(t)
  const socket = await h.ready()
  const controller = new AbortController()
  const rejected = assert.rejects(h.client.request({ ...message(1), value: { toJSON() { controller.abort(); return 1 } } }, 1000, controller.signal), /aborted/)
  await rejected
  assert.deepEqual(socket.writes.map(item => item.op), ['hello'])
  assert.equal(h.timers.size, 0)
})

test('cancellation during socket write is delivered after the submitted operation even under backpressure', async t => {
  const h = await createClientHarness(t)
  const socket = await h.ready()
  const controller = new AbortController()
  const write = socket.write.bind(socket)
  socket.write = (line, callback) => {
    write(line, callback)
    if (JSON.parse(line).op === 'click') controller.abort()
    return false
  }
  await assert.rejects(h.client.request(message(1, 'click'), 1000, controller.signal), /aborted/)
  assert.deepEqual(socket.writes.map(item => item.op), ['hello', 'click', 'cancel'])
  assert.equal(h.client.pending.size, 0)
})

for (const mode of ['throw', 'callback']) {
  test(`socket write ${mode} error rejects and clears request`, async t => {
    const h = await createClientHarness(t)
    const socket = await h.ready()
    socket.write = (_line, callback) => {
      if (mode === 'throw') throw new Error('write failed')
      callback(new Error('write failed'))
    }
    await assert.rejects(h.client.request(message(1), 1000), /write failed/)
    assert.equal(h.client.pending.size, 0)
    assert.equal(h.timers.size, 0)
  })
}

test('closed socket and replaced lifecycle reject before sending', async t => {
  const h = await createClientHarness(t)
  const socket = await h.ready()
  socket.writable = false
  await assert.rejects(h.client.request(message(1), 1000), /connection closed/)
  assert.equal(socket.writes.length, 1)
  socket.writable = true
  const payload = { ...message(2), value: { toJSON() { h.client.lifecycle = new AbortController(); return 1 } } }
  await assert.rejects(h.client.request(payload, 1000), /connection closed/)
  assert.equal(socket.writes.length, 1)
  assert.equal(h.timers.size, 0)
})

for (const event of ['close', 'error', 'exit']) {
  test(`${event} disposes all pending requests once and permits a fresh host`, async t => {
    const h = await createClientHarness(t)
    const socket = await h.ready()
    const child = h.children[0]
    const a = assert.rejects(h.client.request(message(1), 1000), /closed|fixture failure|exited/)
    const b = assert.rejects(h.client.request(message(2), 1000), /closed|fixture failure|exited/)
    if (event === 'exit') child.emit('exit', 1, null)
    else socket.emit(event, ...(event === 'error' ? [new Error('fixture failure')] : []))
    await Promise.all([a, b])
    h.client.dispose()
    assert.equal(h.client.pending.size, 0)
    assert.equal(h.timers.size, 0)
    assert.deepEqual(child.kills, ['SIGTERM'])
    const fresh = await h.ready()
    child.emit('exit', 1, null)
    socket.emit('error', new Error('old socket'))
    assert.equal(h.client.socket, fresh)
    assert.equal(fresh.destroyed, false)
    assert.equal(h.children.length, 2)
  })
}

test('oversized response buffer disposes host and rejects pending calls', async t => {
  const h = await createClientHarness(t)
  const socket = await h.ready()
  const rejected = assert.rejects(h.client.request(message(1), 1000), /buffer limit/)
  socket.emit('data', 'x'.repeat(16 * 1024 * 1024 + 1))
  await rejected
  assert.equal(socket.destroyed, true)
  assert.equal(h.client.buffer, '')
  assert.equal(h.client.pending.size, 0)
})

test('old startup failure cannot dispose the new lifecycle', async t => {
  const h = await createClientHarness(t)
  const oldRejected = assert.rejects(h.client.ensureStarted(), /disposed/)
  h.client.dispose()
  const fresh = await h.ready()
  await oldRejected
  assert.equal(h.client.socket, fresh)
  assert.equal(fresh.destroyed, false)
})
