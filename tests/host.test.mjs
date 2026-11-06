import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

import { HostClient } from '../src/client.js'

const HTML = `<!doctype html>
<html><head><title>Browser use test</title></head>
<body>
  <input id="q" placeholder="Search">
  <button id="go" onclick="document.body.dataset.clicked = '1'">Go</button>
</body></html>`

const URL = `data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`

function frontmost() {
  return execFileSync('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: 'utf8' }).trim()
}

test('host: navigate, snapshot, type, click, eval, screenshot', { timeout: 90_000 }, async () => {
  const before = process.platform === 'darwin' ? frontmost() : ''
  const client = new HostClient()
  try {
    const snapshot = await client.call('navigate', { url: URL })
    const host = await client.call('windowState', {})
    assert.equal(host.opacity, 0)
    assert.equal(host.visible, true)
    assert.equal(host.focused, false)
    assert.ok(host.bounds.x < 0, `expected an offscreen window, got ${JSON.stringify(host.bounds)}`)
    assert.equal(snapshot.url.startsWith('data:text/html'), true)
    assert.equal(snapshot.title, 'Browser use test')
    assert.equal(Array.isArray(snapshot.elements), true)
    assert.ok(snapshot.elements.length >= 2)

    const input = snapshot.elements.find(element => element.kind === 'input')
    assert.ok(input, 'input should be in the snapshot')
    await client.call('type', { ref: input.ref, text: 'dsh' })
    const value = await client.call('eval', { expression: 'document.querySelector("#q").value' })
    assert.equal(value.ok, true)
    assert.equal(value.value, 'dsh')

    const button = snapshot.elements.find(element => element.kind === 'button')
    assert.ok(button, 'button should be in the snapshot')
    await client.call('click', { ref: button.ref })
    const clicked = await client.call('eval', { expression: 'document.body.dataset.clicked' })
    assert.equal(clicked.value, '1')

    if (process.platform === 'darwin') {
      assert.equal(frontmost(), before)
    }

    const shot = await client.call('screenshot', {})
    assert.equal(shot.mime, 'image/jpeg')
    assert.ok(shot.base64.length > 100)
  } finally {
    client.dispose()
  }
})
