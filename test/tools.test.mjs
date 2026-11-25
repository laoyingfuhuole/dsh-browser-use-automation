import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostHarness } from './helpers/host-harness.mjs'
import { componentPrompts } from '../src/prompts.js'

function assertOutput(schema, value) {
  assert.equal(typeof value, 'object')
  assert.notEqual(value, null)
  for (const [key, field] of Object.entries(schema.properties)) {
    if (field.required) assert.ok(Object.hasOwn(value, key), `missing ${key}`)
    if (Object.hasOwn(value, key)) {
      if (field.type === 'array') {
        assert.ok(Array.isArray(value[key]))
        if (field.items.type === 'object') for (const item of value[key]) assertOutput(field.items, item)
      } else assert.equal(typeof value[key], field.type, key)
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties, key), `unexpected ${key}`)
  }
}

async function fixture(t, { failAt, ask } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-use-tools-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const definitions = new Map()
  const calls = []
  const client = { async call(op, payload, signal) { calls.push({ op, payload, signal }); return client.result }, result: {} }
  const context = vm.createContext({ Buffer, AbortSignal })
  const url = new URL('../src/tools.js', import.meta.url)
  const module = new vm.SourceTextModule(readFileSync(url, 'utf8'), { context, identifier: url.href })
  await module.link(async specifier => {
    const exports = specifier === '@deepseek-ai/dsh-tools' ? { defineTool: value => value } : await import(specifier)
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  const register = options => module.namespace.registerTools({ get: name => name === 'userQuestions' && ask ? { ask } : undefined, tools: { register(definition) {
    if (definition.name === failAt) throw new Error('fixture registration failed')
    definitions.set(definition.name, definition)
    return () => definitions.delete(definition.name)
  } } }, client, { screenshotDir: directory }, options)
  const exec = { agent: { id: 'trusted-chat' }, signal: new AbortController().signal }
  return { definitions, calls, client, register, exec, directory, module }
}

test('all tools register once with executable schemas and renderers', async t => {
  const h = await fixture(t)
  h.register()
  assert.equal(h.definitions.size, 23)
  for (const definition of h.definitions.values()) {
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.output.schema.type, 'object')
    assert.ok(definition.timeoutMs > 0)
    assert.equal(typeof definition.isConcurrencySafe(), 'boolean')
  }
})

test('tools trust exec.agent.id, forward cancellation and reject missing identity before dispatch', async t => {
  const h = await fixture(t)
  h.register()
  const open = h.definitions.get('browser_use_open')
  await open.execute({ url: 'https://example.test/', conversationId: 'untrusted' }, h.exec)
  assert.equal(h.calls[0].op, 'navigate')
  assert.equal(h.calls[0].payload.conversationId, 'trusted-chat')
  assert.equal(h.calls[0].signal, h.exec.signal)
  for (const exec of [undefined, {}, { agent: { id: ' ' } }]) {
    await assert.rejects(open.execute({ url: 'https://example.test/' }, exec), /exec.agent.id/)
  }
  assert.equal(h.calls.length, 1)
})

test('read forwards its scope and budget, renders text and exposes truncation and coverage limits', async t => {
  const h = await fixture(t)
  h.register()
  const tool = h.definitions.get('browser_use_read')
  h.client.result = { url: 'https://example.test/', title: 'Article', text: 'body text', offset: 0, totalChars: 20, returnedChars: 9, truncated: true, hasMore: true, nextCursor: 'opaque' }
  const result = await tool.execute({ selector: 'main', maxChars: 9 }, h.exec)
  assert.equal(h.calls[0].op, 'read')
  assert.equal(h.calls[0].payload.selector, 'main')
  assert.equal(h.calls[0].payload.maxChars, 9)
  assert.equal(h.calls[0].payload.conversationId, 'trusted-chat')
  assert.equal(h.calls[0].signal, h.exec.signal)
  const text = tool.output.render({}, result)[0].text
  assert.match(text, /body text/)
  assert.match(text, /0–9 of 20 \(returned 9\)/)
  assert.match(text, /cursor: opaque/)
  assert.match(text, /no frame traversal/)
  await tool.execute({}, h.exec)
  assert.equal(h.calls[1].payload.maxChars, undefined)
  assert.equal(h.calls[1].payload.selector, undefined)
})

test('read forwards opaque cursors and renders continuation guidance', async t => {
  const h = await fixture(t)
  h.register()
  const tool = h.definitions.get('browser_use_read')
  h.client.result = { url: 'https://example.test/', title: 'Article', text: 'next', offset: 4, totalChars: 20, returnedChars: 4, truncated: true, hasMore: true, nextCursor: 'opaque' }
  const result = await tool.execute({ cursor: 'previous', maxChars: 4 }, h.exec)
  assert.equal(h.calls[0].payload.cursor, 'previous')
  assert.match(tool.output.render({}, result)[0].text, /More available\. Call browser_use_read with cursor: opaque/)
})

test('a model can continue from the rendered cursor and every real read result matches its schema', async t => {
  const host = await createHostHarness(t)
  const h = await fixture(t)
  h.register()
  h.client.call = async (op, payload) => {
    const response = await host.run(op, payload.conversationId, payload)
    assert.equal(response.ok, true, response.error)
    return response.result
  }
  await host.run('state', 'trusted-chat')
  const root = host.natives[0].page.element
  root.innerText = 'article😀tail'
  const tool = h.definitions.get('browser_use_read')
  const first = await tool.execute({ selector: 'article', maxChars: 7 }, h.exec)
  assertOutput(tool.output.schema, first)
  const rendered = tool.output.render({}, first)[0].text
  const cursor = rendered.match(/with cursor: ([A-Za-z0-9_.-]+)/)?.[1]
  assert.equal(cursor, first.nextCursor)
  const second = await tool.execute({ cursor, maxChars: 20 }, h.exec)
  assertOutput(tool.output.schema, second)
  assert.equal(first.text + second.text, root.innerText)
  assert.equal(second.offset, first.returnedChars)
  assert.equal(second.hasMore, false)
  assert.equal(Object.hasOwn(second, 'nextCursor'), false)
  assert.equal(Object.hasOwn(second, 'fingerprint'), false)
  assert.match(tool.output.render({}, second)[0].text, /End of selected text/)
  root.innerText = ''
  const empty = await tool.execute({ selector: 'article' }, h.exec)
  assertOutput(tool.output.schema, empty)
  assert.equal(empty.offset, 0)
  assert.equal(empty.returnedChars, 0)
})

test('scoped snapshot and fast type forward options and match actual host output schemas', async t => {
  const host = await createHostHarness(t)
  const h = await fixture(t)
  h.register()
  h.client.call = async (op, payload) => {
    const response = await host.run(op, payload.conversationId, payload)
    assert.equal(response.ok, true, response.error)
    return response.result
  }
  await host.run('state', 'trusted-chat')
  const page = host.natives[0].page
  page.element.querySelectorAll = () => []
  page.element.type = 'password'
  page.element.value = 'fixture-private-value'
  const snapshot = h.definitions.get('browser_use_snapshot')
  const result = await snapshot.execute({ selector: '#field', maxElements: 1, includeSelectors: false }, h.exec)
  assertOutput(snapshot.output.schema, result)
  assert.equal(result.elements.length, 1)
  assert.equal(result.selector, '#field')
  assert.equal(result.truncated, false)
  assert.equal(result.elements[0].selector, undefined)
  assert.equal(snapshot.isConcurrencySafe(), false)
  assert.doesNotMatch(snapshot.output.render({}, result)[0].text, /fixture-private-value/)
  page.element.value = ''
  const input = h.definitions.get('browser_use_type')
  const typed = await input.execute({ ref: result.elements[0].ref, text: 'hello😀', mode: 'fast' }, h.exec)
  assertOutput(input.output.schema, typed)
  assert.equal(typed.typed, 6)
  assert.equal(page.element.value, 'hello😀')
})

test('hover forwards only its ref and trusted routing and reports dispatch rather than menu success', async t => {
  const h = await fixture(t)
  h.register()
  const tool = h.definitions.get('browser_use_hover')
  h.client.result = { dispatched: true, ref: 151, x: 60, y: 35 }
  const result = await tool.execute({ ref: 151, conversationId: 'other' }, h.exec)
  assert.equal(h.calls[0].op, 'hover')
  assert.equal(h.calls[0].payload.ref, 151)
  assert.equal(h.calls[0].payload.conversationId, 'trusted-chat')
  assert.equal(h.calls[0].signal, h.exec.signal)
  assert.equal(tool.isConcurrencySafe(), false)
  assert.match(tool.output.render({}, result)[0].text, /without clicking.*Dispatch only/)
  await assert.rejects(tool.execute({ ref: 151 }, {}), /exec.agent.id/)
  assert.equal(h.calls.length, 1)
})

test('model-facing input guidance describes replacing selected text and counts dispatches', async t => {
  const h = await fixture(t)
  h.register()
  const type = h.definitions.get('browser_use_type')
  for (const guidance of [type.description, componentPrompts.basic]) {
    assert.match(guidance, /replac\w* (any )?selected text/i)
    assert.doesNotMatch(guidance, /append/i)
  }
  for (const tool of [type, h.definitions.get('browser_use_insert_text')]) {
    assert.match(tool.output.render({}, { typed: 3 })[0].text, /dispatched 3 unicode code points/i)
  }
})

test('scroll and key tools expose constrained actions and preserve conversation routing', async t => {
  const h = await fixture(t)
  h.register()
  await h.definitions.get('browser_use_scroll').execute({ deltaY: -500, x: 25 }, h.exec)
  await h.definitions.get('browser_use_key').execute({ key: 'Mod+ArrowLeft' }, h.exec)
  assert.deepEqual(h.calls.map(({ op, payload }) => [op, payload.conversationId, payload.deltaY, payload.x, payload.key]), [
    ['scroll', 'trusted-chat', -500, 25, undefined],
    ['key', 'trusted-chat', undefined, undefined, 'Mod+ArrowLeft'],
  ])
})

test('reset requires strict confirmation before sending while close stays scoped', async t => {
  const h = await fixture(t)
  h.register()
  const reset = h.definitions.get('browser_use_reset')
  for (const confirm of [undefined, false, 'true', 1]) {
    await assert.rejects(reset.execute({ confirm }, h.exec), /confirm === true/)
  }
  assert.equal(h.calls.length, 0)
  await reset.execute({ confirm: true }, h.exec)
  await h.definitions.get('browser_use_close').execute({}, h.exec)
  assert.deepEqual(h.calls.map(({ op, payload }) => [op, payload.conversationId]), [['reset', 'trusted-chat'], ['close', 'trusted-chat']])
})

test('empty assertions fail without RPC and multiple conditions use AND with safely encoded text', async t => {
  const h = await fixture(t)
  h.register()
  const tool = h.definitions.get('browser_use_assert')
  for (const args of [{}, { selector: ' ', text: '\n', url: '', js: '\t' }]) {
    await assert.rejects(tool.execute(args, h.exec), /at least one non-empty/)
  }
  assert.equal(h.calls.length, 0)
  const text = 'quote"\nslash\\'
  const page = { document: { querySelector: value => value === '#target', body: { innerText: text } }, location: { href: 'https://example.test/ok' } }
  h.client.result = { ok: true, value: 'true' }
  assert.equal((await tool.execute({ selector: '#target', text, url: '/ok', js: '2 > 1' }, h.exec)).pass, true)
  const expression = h.calls.at(-1).payload.expression
  assert.equal(vm.runInNewContext(expression, page), true)
  page.document.body.innerText = 'different'
  assert.equal(vm.runInNewContext(expression, page), false)
})

test('assertions report false values and page exceptions as failure', async t => {
  const h = await fixture(t)
  h.register()
  const tool = h.definitions.get('browser_use_assert')
  h.client.result = { ok: true, value: 'false' }
  assert.equal((await tool.execute({ text: 'missing' }, h.exec)).pass, false)
  h.client.result = { ok: false, exception: 'invalid selector' }
  const result = await tool.execute({ selector: '[' }, h.exec)
  assert.equal(result.pass, false)
  assert.equal(result.detail, 'invalid selector')
})

test('eval render distinguishes host truncation, display shortening and assert-sized results', async t => {
  const h = await fixture(t)
  h.register()
  const tool = h.definitions.get('browser_use_eval')
  const truncated = tool.output.render({}, { ok: true, value: 'x', truncated: true })[0].text
  assert.match(truncated, /Result truncated by the browser host/)
  const display = tool.output.render({}, { ok: true, value: 'x'.repeat(50_001), truncated: false })[0].text
  assert.match(display, /Display shortened to 50,000 characters/)
  const complete = tool.output.render({}, { ok: true, value: 'true', truncated: false })[0].text
  assert.doesNotMatch(complete, /truncated|shortened/)
})

test('registration errors include the tool name and stop subsequent registration', async t => {
  const h = await fixture(t, { failAt: 'browser_use_click' })
  assert.throws(h.register, /could not register browser_use_click.*fixture registration failed/)
  assert.deepEqual([...h.definitions.keys()], [], 'partial group registrations must roll back')
})

test('component-scoped registration exposes only its tools and unload removes them', async t => {
  const h = await fixture(t)
  const controller = new AbortController()
  const remove = h.register({ names: ['browser_use_read'], signal: controller.signal })
  assert.deepEqual([...h.definitions.keys()], ['browser_use_read'])
  const tool = h.definitions.get('browser_use_read')
  await tool.execute({}, h.exec)
  assert.equal(h.calls.length, 1)
  controller.abort(new Error('read component disabled'))
  await assert.rejects(tool.execute({}, h.exec), /read component disabled/)
  assert.equal(h.calls.length, 1)
  remove()
  remove()
  assert.equal(h.definitions.size, 0)
})

test('component unload aborts a pending human approval before any browser acceptance', async t => {
  let resolveApproval
  let question
  const h = await fixture(t, { ask: request => {
    question = request
    return new Promise(resolve => { resolveApproval = resolve })
  } })
  const controller = new AbortController()
  h.register({ names: ['browser_use_respond'], signal: controller.signal })
  h.client.result = { requests: [{ id: 'dialog', kind: 'confirm', url: 'https://example.test', message: 'Confirm' }], audit: [] }
  const work = h.definitions.get('browser_use_respond').execute({ requestId: 'dialog', accept: true }, h.exec)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(question)
  controller.abort(new Error('component removed'))
  assert.equal(question.signal.aborted, true)
  resolveApproval({ answers: [{ id: question.questions[0].id, selected: ['仅本次允许'] }] })
  await assert.rejects(work, /approval cancelled/)
  assert.equal(h.calls.length, 1)
})

test('turning request handling off aborts a file-component approval and never dispatches upload', async t => {
  let resolveApproval
  let question
  const h = await fixture(t, { ask: request => {
    question = request
    return new Promise(resolve => { resolveApproval = resolve })
  } })
  const requestController = new AbortController()
  h.register({ names: ['browser_use_upload'], approvalSignal: () => requestController.signal })
  h.client.result = { requests: [{ id: 'upload', kind: 'upload', url: 'https://example.test', message: 'Upload' }], audit: [] }
  const work = h.definitions.get('browser_use_upload').execute({ requestId: 'upload', paths: ['/fixture/file.txt'] }, h.exec)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(question)
  requestController.abort(new Error('requests disabled'))
  resolveApproval({ answers: [{ id: question.questions[0].id, selected: ['仅本次允许'] }] })
  await assert.rejects(work, /approval cancelled/)
  assert.equal(h.calls.length, 1)
})

test('screenshots decode base64 into unique files and fullPage remains unimplemented', async t => {
  const h = await fixture(t)
  h.register()
  h.client.result = { base64: Buffer.from('fixture image bytes').toString('base64') }
  const shot = h.definitions.get('browser_use_screenshot')
  const a = await shot.execute({ fullPage: true }, h.exec)
  const b = await shot.execute({}, h.exec)
  assert.notEqual(a.path, b.path)
  assert.equal(readFileSync(a.path, 'utf8'), 'fixture image bytes')
  assert.equal(a.bytes, Buffer.byteLength('fixture image bytes'))
  assert.equal(a.mime, 'image/jpeg')
  assert.equal(h.calls[0].payload.fullPage, undefined)
})

test('download query renders actual paths and terminal states and matches the host schema', async t => {
  const host = await createHostHarness(t)
  const h = await fixture(t)
  h.register()
  const tool = h.definitions.get('browser_use_downloads')
  h.client.call = async (op, payload) => {
    assert.equal(op, 'downloads')
    assert.equal(payload.conversationId, 'trusted-chat')
    return (await host.run(op, payload.conversationId)).result
  }
  const empty = await tool.execute({}, h.exec)
  assertOutput(tool.output.schema, empty)
  assert.match(tool.output.render({}, empty)[0].text, /No downloads recorded/)
  const completed = { downloads: [{ id: 'one', filename: 'report.pdf', state: 'completed', path: '/tmp/report.pdf', receivedBytes: 12, totalBytes: 12 }] }
  assertOutput(tool.output.schema, completed)
  assert.match(tool.output.render({}, completed)[0].text, /completed: report.pdf.*\nPath: \/tmp\/report.pdf/)
  const failed = { downloads: [{ id: 'two', filename: 'report.pdf', state: 'failed', receivedBytes: 0, totalBytes: 12, error: 'disk denied' }] }
  assertOutput(tool.output.schema, failed)
  assert.match(tool.output.render({}, failed)[0].text, /Error: disk denied/)
})

test('browser acceptance is gated by a main-conversation human answer and preserves prompt text', async t => {
  const asked = []
  const h = await fixture(t, { ask: async request => {
    asked.push(request)
    return { answers: [{ id: request.questions[0].id, selected: ['仅本次允许'] }] }
  } })
  h.register()
  h.client.call = async (op, payload) => {
    h.calls.push({ op, payload })
    if (op === 'requests') return { requests: [{ id: 'pending', kind: 'prompt', url: 'https://example.test', message: 'Proceed?', defaultValue: 'default' }], audit: [] }
    return { id: 'pending', accepted: payload.accept }
  }
  const result = await h.definitions.get('browser_use_respond').execute({ requestId: 'pending', accept: true, value: 'answer' }, h.exec)
  assert.equal(result.accepted, true)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].agent, h.exec.agent)
  assert.equal(asked[0].signal, h.exec.signal)
  assert.equal(asked[0].questions[0].intent.kind, 'approval')
  assert.match(asked[0].questions[0].detail, /拟提交文本：answer/)
  assert.equal(h.calls.at(-1).payload.value, 'answer')
})

test('skipped/negative approval never accepts a browser request or uploads files', async t => {
  for (const selected of [[], ['拒绝']]) {
    const h = await fixture(t, { ask: async request => ({ answers: [{ id: request.questions[0].id, selected }] }) })
    h.register()
    h.client.call = async (op, payload) => {
      h.calls.push({ op, payload })
      if (op === 'requests') return { requests: [{ id: 'file', kind: 'upload', url: 'https://example.test', message: 'Upload' }], audit: [] }
      return { id: 'file', accepted: false }
    }
    const result = await h.definitions.get('browser_use_upload').execute({ requestId: 'file', paths: ['/fixture/report.pdf'] }, h.exec)
    assert.equal(result.files, 0)
    assert.equal(h.calls.some(call => call.op === 'upload'), false)
    assert.equal(h.calls.at(-1).payload.accept, false)
  }
})

test('missing main-conversation service fails explicitly rather than trusting a model confirm flag', async t => {
  const h = await fixture(t)
  h.register()
  h.client.result = { requests: [{ id: 'dialog', kind: 'confirm', url: 'https://example.test', message: 'confirm' }], audit: [] }
  await assert.rejects(h.definitions.get('browser_use_respond').execute({ requestId: 'dialog', accept: true }, h.exec), /userQuestions service is unavailable/)
  assert.equal(h.calls.length, 1)
})

test('cancelled main-conversation approval cannot accept a pending browser request', async t => {
  const controller = new AbortController()
  const h = await fixture(t, { ask: async request => {
    controller.abort()
    return { answers: [{ id: request.questions[0].id, selected: ['仅本次允许'] }] }
  } })
  h.register()
  h.client.result = { requests: [{ id: 'dialog', kind: 'confirm', url: 'https://example.test', message: 'confirm' }], audit: [] }
  await assert.rejects(h.definitions.get('browser_use_respond').execute({ requestId: 'dialog', accept: true }, { ...h.exec, signal: controller.signal }), /approval cancelled/)
  assert.equal(h.calls.length, 1)
})

test('unsupported browser requests reject acceptance before asking and can be dismissed explicitly', async t => {
  let questions = 0
  const h = await fixture(t, { ask: async () => { questions++; throw new Error('must not ask') } })
  h.register()
  h.client.call = async (op, payload) => {
    h.calls.push({ op, payload })
    if (op === 'requests') return { requests: [{ id: 'blocked', kind: 'unsupported', url: 'https://example.test/', message: 'showDirectoryPicker' }], audit: [] }
    return { id: 'blocked', accepted: false }
  }
  const tool = h.definitions.get('browser_use_respond')
  await assert.rejects(tool.execute({ requestId: 'blocked', accept: true }, h.exec), /unsupported/)
  const result = await tool.execute({ requestId: 'blocked', accept: false }, h.exec)
  assert.equal(result.accepted, false)
  assert.equal(questions, 0)
})

test('approved file selection traverses host requests, DSH approval and one-shot upload with valid output schemas', async t => {
  const host = await createHostHarness(t)
  let asked = 0
  const h = await fixture(t, { ask: async request => {
    asked++
    assert.match(request.questions[0].detail, /https:\/\/example.test\//)
    return { answers: [{ id: request.questions[0].id, selected: ['仅本次允许'] }] }
  } })
  h.register()
  h.client.call = async (op, payload) => {
    const response = await host.run(op, payload.conversationId, payload)
    if (!response.ok) throw new Error(response.error)
    return response.result
  }
  await host.run('state', 'trusted-chat')
  const win = host.natives[0]
  win.page.location.href = 'https://example.test/'
  win.webContents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'fixture-frame', backendNodeId: 10, mode: 'selectSingle' })
  await host.flush()
  const inspect = h.definitions.get('browser_use_requests')
  const status = await inspect.execute({}, h.exec)
  assertOutput(inspect.output.schema, status)
  assert.equal(status.requests[0].kind, 'upload')
  host.filesystem.files.set('/fixture/upload.pdf', 20)
  win.onCommand = method => method === 'DOM.describeNode'
    ? Promise.resolve({ node: { nodeName: 'INPUT', attributes: ['type', 'file'] } })
    : undefined
  const upload = h.definitions.get('browser_use_upload')
  const input = { requestId: status.requests[0].id, paths: ['/fixture/upload.pdf'] }
  const result = await upload.execute(input, h.exec)
  assertOutput(upload.output.schema, result)
  assert.equal(result.files, 1)
  assert.equal(asked, 1)
  await assert.rejects(upload.execute(input, h.exec), /stale/)
  assert.equal(asked, 1)
  const after = await inspect.execute({}, h.exec)
  assertOutput(inspect.output.schema, after)
  assert.equal(after.audit.at(-1).outcome, 'upload-dispatched')
})

test('file upload approval shows exact paths and current request id remains bound across the human wait', async t => {
  let reviewed
  const h = await fixture(t, { ask: async request => {
    reviewed = request.questions[0].detail
    return { answers: [{ id: request.questions[0].id, selected: ['仅本次允许'] }] }
  } })
  h.register()
  h.client.call = async (op, payload) => {
    h.calls.push({ op, payload })
    if (op === 'requests') return { requests: [{ id: 'file', kind: 'upload', url: 'https://example.test/upload', message: 'Upload' }], audit: [] }
    throw new Error('stale browser request')
  }
  await assert.rejects(h.definitions.get('browser_use_upload').execute({ requestId: 'file', paths: ['/fixture/quoted file.pdf'] }, h.exec), /stale browser request/)
  assert.match(reviewed, /https:\/\/example.test\/upload/)
  assert.match(reviewed, /\/fixture\/quoted file.pdf/)
  assert.equal(h.calls.at(-1).payload.requestId, 'file')
})

test('snapshot renderer preserves refs and clearly reports empty or truncated results', async t => {
  const h = await fixture(t)
  const format = h.module.namespace.formatSnapshot
  assert.match(format({ url: 'https://example.test/', elements: [] }), /no interactive elements/)
  const text = format({ url: 'https://example.test/', title: 'Page', elements: [{ ref: 151, kind: 'button', label: 'Submit', selector: '#submit' }], truncated: true })
  assert.match(text, /\[151\] button "Submit" \{#submit\}/)
  assert.match(text, /truncated at 150 elements/)
})
