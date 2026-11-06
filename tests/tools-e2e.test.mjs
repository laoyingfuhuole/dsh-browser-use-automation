import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const HTML = `<!doctype html><html><head><title>Tool test</title></head>
<body><input id="q" placeholder="Search"><button id="go" onclick="document.body.dataset.clicked='1'">Go</button></body></html>`
const URL = `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`

test('tools: open, type, click, assert, screenshot through the plugin', { timeout: 90_000 }, async () => {
  const tools = []
  const cleanups = []
  const dir = mkdtempSync(join(tmpdir(), 'dsh-browser-use-'))
  const ctx = {
    tools: { register: definition => tools.push(definition) },
    systemPrompt: { section: () => {} },
    effect: factory => cleanups.push(factory()),
    logger: { warn: () => {} },
  }
  apply(ctx, { screenshotDir: dir })
  const tool = name => {
    const found = tools.find(candidate => candidate.name === name)
    assert.ok(found, `${name} should be registered`)
    return found
  }
  const exec = { signal: new AbortController().signal }
  try {
    const snapshot = await tool('browser_use_open').execute({ url: URL }, exec)
    assert.equal(snapshot.title, 'Tool test')
    const input = snapshot.elements.find(element => element.kind === 'input')
    assert.ok(input)
    await tool('browser_use_type').execute({ ref: input.ref, text: 'dsh' }, exec)
    const value = await tool('browser_use_eval').execute({ expression: 'document.querySelector("#q").value' }, exec)
    assert.equal(value.value, 'dsh')

    const button = snapshot.elements.find(element => element.kind === 'button')
    assert.ok(button)
    await tool('browser_use_click').execute({ ref: button.ref }, exec)
    const assertion = await tool('browser_use_assert').execute({ js: 'document.body.dataset.clicked === "1"' }, exec)
    assert.equal(assertion.pass, true)

    const shot = await tool('browser_use_screenshot').execute({}, exec)
    assert.equal(shot.mime, 'image/jpeg')
    assert.ok(shot.bytes > 100)
    const stat = await import('node:fs').then(fs => fs.statSync(shot.path))
    assert.equal(stat.size, shot.bytes)

    await tool('browser_use_close').execute({}, exec)
  } finally {
    for (const cleanup of cleanups) cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
