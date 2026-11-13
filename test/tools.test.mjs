import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function fixture(t, { failAt } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-use-tools-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const definitions = new Map()
  const calls = []
  const client = { async call(op, payload, signal) { calls.push({ op, payload, signal }); return client.result }, result: {} }
  const context = vm.createContext({ Buffer })
  const url = new URL('../src/tools.js', import.meta.url)
  const module = new vm.SourceTextModule(readFileSync(url, 'utf8'), { context, identifier: url.href })
  await module.link(async specifier => {
    const exports = specifier === '@deepseek-ai/dsh-tools' ? { defineTool: value => value } : await import(specifier)
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  const register = () => module.namespace.registerTools({ tools: { register(definition) {
    if (definition.name === failAt) throw new Error('fixture registration failed')
    definitions.set(definition.name, definition)
  } } }, client, { screenshotDir: directory })
  const exec = { agent: { id: 'trusted-chat' }, signal: new AbortController().signal }
  return { definitions, calls, client, register, exec, directory, module }
}

test('all tools register once with executable schemas and renderers', async t => {
  const h = await fixture(t)
  h.register()
  assert.equal(h.definitions.size, 18)
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
  h.client.result = { url: 'https://example.test/', title: 'Article', text: 'body text', totalChars: 20, returnedChars: 9, truncated: true }
  const result = await tool.execute({ selector: 'main', maxChars: 9 }, h.exec)
  assert.equal(h.calls[0].op, 'read')
  assert.equal(h.calls[0].payload.selector, 'main')
  assert.equal(h.calls[0].payload.maxChars, 9)
  assert.equal(h.calls[0].payload.conversationId, 'trusted-chat')
  assert.equal(h.calls[0].signal, h.exec.signal)
  const text = tool.output.render({}, result)[0].text
  assert.match(text, /body text/)
  assert.match(text, /9\/20.*truncated/)
  assert.match(text, /no frame traversal/)
  await tool.execute({}, h.exec)
  assert.equal(h.calls[1].payload.maxChars, undefined)
  assert.equal(h.calls[1].payload.selector, undefined)
})

test('read forwards opaque cursors and renders continuation guidance', async t => {
  const h = await fixture(t)
  h.register()
  const tool = h.definitions.get('browser_use_read')
  h.client.result = { url: 'https://example.test/', title: 'Article', text: 'next', totalChars: 20, returnedChars: 4, truncated: true, hasMore: true, nextCursor: 'opaque' }
  const result = await tool.execute({ cursor: 'previous', maxChars: 4 }, h.exec)
  assert.equal(h.calls[0].payload.cursor, 'previous')
  assert.match(tool.output.render({}, result)[0].text, /more available; call browser_use_read with nextCursor/)
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
  assert.deepEqual([...h.definitions.keys()], ['browser_use_open', 'browser_use_snapshot'])
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

test('snapshot renderer preserves refs and clearly reports empty or truncated results', async t => {
  const h = await fixture(t)
  const format = h.module.namespace.formatSnapshot
  assert.match(format({ url: 'https://example.test/', elements: [] }), /no interactive elements/)
  const text = format({ url: 'https://example.test/', title: 'Page', elements: [{ ref: 151, kind: 'button', label: 'Submit', selector: '#submit' }], truncated: true })
  assert.match(text, /\[151\] button "Submit" \{#submit\}/)
  assert.match(text, /truncated at 150 elements/)
})
