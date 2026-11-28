import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BrowserCore } from '../src/core.js'

const definitions = JSON.parse(readFileSync(new URL('../src/components.json', import.meta.url), 'utf8'))

test('component map owns every tool exactly once and every export resolves inside one package', () => {
  const tools = Object.values(definitions).flatMap(group => group.tools)
  assert.equal(new Set(tools).size, tools.length)
  assert.equal(tools.length, 24)
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /id: dsh-browser-use-automation\s+name: dsh-browser-use-automation\s/)
  for (const group of Object.keys(definitions)) {
    assert.equal(import.meta.resolve(`dsh-browser-use-automation/${group}`), new URL(`..${pkg.exports['./' + group].slice(1)}`, import.meta.url).href)
    assert.match(patch, new RegExp(`name: dsh-browser-use-automation/${group}(?:\\s|$)`))
  }
  for (const group of ['core', ...Object.keys(definitions)]) {
    const specifier = `dsh-browser-use-automation${group === 'core' ? '' : '/' + group}`
    for (const language of ['en', 'zh']) {
      const meta = JSON.parse(readFileSync(new URL(import.meta.resolve(`${specifier}/locale/${language}.json`)), 'utf8'))
      assert.ok(meta.meta.title)
      assert.ok(meta.meta.description)
    }
  }
})

test('one core shares one client, mount is lazy and unloading one component does not dispose the host', async () => {
  const calls = []
  const configurations = []
  let disposed = 0
  const client = {
    call(op, payload, signal) { calls.push({ op, payload, signal }); return Promise.resolve({ ok: true }) },
    configureComponents(value) { configurations.push(value) }, dispose() { disposed++ },
  }
  const core = new BrowserCore({}, client)
  const basic = core.mount('basic')
  const read = core.mount('read')
  assert.equal(calls.length, 0)
  await read.call('read', { conversationId: 'A' })
  assert.equal(calls[0].payload.component, 'read')
  const signal = calls[0].signal
  read.dispose()
  assert.equal(signal.aborted, true)
  assert.equal(disposed, 0)
  await assert.rejects(read.call('read', { conversationId: 'A' }), /disabled/)
  await basic.call('state', { conversationId: 'A' })
  assert.equal(calls[1].payload.component, 'basic')
  assert.deepEqual(configurations.at(-1), ['basic'])
  core.dispose()
  core.dispose()
  assert.equal(disposed, 1)
  assert.equal(basic.signal.aborted, true)
})

test('duplicate components fail explicitly and a newly mounted lease does not inherit old cancellation', async () => {
  const client = { configureComponents() {}, dispose() {}, async call() { return 'active' } }
  const core = new BrowserCore({}, client)
  const old = core.mount('files')
  assert.throws(() => core.mount('files'), /already mounted/)
  old.dispose()
  const fresh = core.mount('files')
  old.dispose()
  assert.equal(fresh.signal.aborted, false)
  assert.equal(await fresh.call('downloads', { conversationId: 'A' }), 'active')
  core.dispose()
  assert.throws(() => core.mount('files'), /disposed/)
})
