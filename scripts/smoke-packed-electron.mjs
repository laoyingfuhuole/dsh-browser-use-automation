import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const [directory] = process.argv.slice(2)
if (!directory || process.argv.length !== 3) throw new Error('Usage: node scripts/smoke-packed-electron.mjs <extracted-package-directory>')
const { verifyInstallation } = await import(pathToFileURL(resolve(directory, 'src/integrity.js')).href)
const { HostClient, resolveElectronPath } = await import(pathToFileURL(resolve(directory, 'src/client.js')).href)
verifyInstallation()
const electron = resolveElectronPath()
const root = await mkdtemp(join(tmpdir(), 'browser-use-packed-smoke-'))
const fixture = 'fixture download\n'
const submissions = []
let retryAttempts = 0
const server = createServer(async (request, response) => {
  if (request.url === '/retry') {
    const status = ++retryAttempts === 1 ? 503 : 200
    response.writeHead(status, { 'Content-Type': 'text/html' })
    return response.end(status === 503 ? '<title>Unavailable</title>' : '<title>Recovered</title>')
  }
  if (request.url === '/forms') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return response.end(`<!doctype html><meta charset="utf-8"><title>Form controls</title>
      <form onsubmit="event.preventDefault(); window.submits++"><input id="field"><button>Submit</button></form>
      <script>window.submits = 0</script><textarea id="editor"></textarea><input id="locked" readonly>
      <div id="rich" contenteditable></div><button id="ordinary">Regular button</button><div id="shadowHost"></div>
      <iframe id="child" srcdoc="<textarea></textarea>"></iframe>
      <div id="region" style="display:contents">Lead <span style="display:contents">visible<span hidden>secret</span></span> tail</div>
      <div style="display:none"><div id="hidden-region" style="display:contents">secret</div></div>
      <form action="/form-result" target="_blank" method="POST">
        <input id="payload" name="term" value="a &amp; b"><button id="post">Send</button>
      </form>`)
  }
  if (request.url === '/form-result') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    submissions.push({ method: request.method, body: Buffer.concat(chunks).toString(), headers: request.headers })
    response.writeHead(200, { 'Content-Type': 'text/html' })
    return response.end('<title>Form received</title>')
  }
  if (request.url === '/file') {
    response.writeHead(200, { 'Content-Disposition': 'attachment; filename="fixture.txt"', 'Content-Length': Buffer.byteLength(fixture) })
    return response.end(fixture)
  }
  if (request.url === '/oversized') {
    response.writeHead(200, { 'Content-Disposition': 'attachment; filename="oversized.txt"', 'Content-Length': 1536 })
    return response.end('x'.repeat(1536))
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' })
  response.end('<!doctype html><title>Packed smoke</title><input id="password" type="password" value="fixture-password"><textarea id="code">fixture-code</textarea><a href="/file">Download fixture</a> <a href="/oversized">Oversized fixture</a>')
})

async function until(check) {
  const deadline = Date.now() + 8000
  do {
    const found = await check()
    if (found) return found
    await delay(50)
  } while (Date.now() < deadline)
  throw new Error('timed out waiting for Electron smoke-test state')
}

async function smoke(mode, url) {
  Object.assign(process.env, {
    ELECTRON_PATH: electron, DSH_HOME: root,
    BROWSER_USE_USER_DATA_DIR: join(root, mode, 'profile'),
    BROWSER_USE_DOWNLOAD_DIR: join(root, mode, 'downloads'),
    BROWSER_USE_SESSION_MODE: mode, BROWSER_USE_HIDE_DOCK: '1', BROWSER_USE_KEEP_DOCK: '0',
    BROWSER_USE_DOWNLOAD_MAX_FILE_BYTES: '1024', BROWSER_USE_DOWNLOAD_MAX_CONCURRENT: '4',
    BROWSER_USE_DOWNLOAD_MAX_DIRECTORY_BYTES: '2048',
  })
  const client = new HostClient({ components: ['basic', 'files', 'eval', 'requests', 'read'] })
  const call = (op, conversationId, payload) => client.call(op, { conversationId, ...payload }, AbortSignal.timeout(20_000))
  const evaluate = async (conversationId, expression) => {
    const result = await call('eval', conversationId, { expression })
    assert.equal(result.ok, true, result.exception)
    return result.value
  }
  try {
    const page = await call('navigate', 'A', { url })
    assert.equal(page.title, 'Packed smoke')
    assert.doesNotMatch(JSON.stringify(page), /fixture-password|fixture-code/)
    assert.equal(page.elements.find(element => element.selector === '#password').label, 'password')
    await evaluate('A', "document.cookie = 'fixture=1'; localStorage.setItem('fixture', 'saved')")
    await call('navigate', 'B', { url })
    const storage = id => evaluate(id, "JSON.stringify([document.cookie, localStorage.getItem('fixture')])").then(JSON.parse)
    const expected = mode === 'isolated' ? ['', null] : ['fixture=1', 'saved']
    assert.deepEqual(await storage('B'), expected)
    await call('reset', 'A')
    const fresh = await call('navigate', 'A', { url })
    assert.deepEqual(await storage('A'), expected)
    const dialog = call('eval', 'A', { expression: "window.fixtureAnswer = confirm('fixture confirmation')" })
    const interrupted = assert.rejects(dialog, /request is pending/)
    const request = await until(async () => (await call('requests', 'A')).requests.find(item => item.kind === 'confirm'))
    assert.deepEqual((await call('requests', 'B')).requests, [])
    const otherTab = (await call('tabs', 'A', { action: 'new' })).activeTabId
    await assert.rejects(call('respond', 'A', { tabId: otherTab, requestId: request.id, accept: false }), /stale/)
    await call('respond', 'A', { requestId: request.id, accept: false })
    await call('tabs', 'A', { action: 'close', tabId: otherTab })
    await interrupted
    assert.equal(await evaluate('A', 'window.fixtureAnswer'), 'false')
    await call('click', 'A', { ref: fresh.elements.find(element => element.label === 'Download fixture').ref })
    const download = await until(async () => (await call('downloads', 'A')).downloads.find(entry => entry.state === 'completed'))
    assert.equal(await readFile(download.path, 'utf8'), fixture)
    const afterDownload = await call('snapshot', 'A')
    await call('click', 'A', { ref: afterDownload.elements.find(element => element.label === 'Oversized fixture').ref })
    const denied = await until(async () => (await call('downloads', 'A')).downloads.find(entry => entry.filename === 'oversized.txt' && entry.state === 'failed'))
    assert.match(denied.error, /single-file limit/)
    assert.equal(denied.path, undefined)
    assert.deepEqual((await call('downloads', 'B')).downloads, [])
    console.log(`PASS: packed Electron (${mode}): navigation, snapshot privacy, storage, dialog and download`)
    await checkTabs(url, (op, payload) => call(op, 'A', payload))
    console.log(`PASS: packed Electron (${mode}): inactive tab click, screenshot pixels, shared tab storage and opener closure`)
    await checkForms(url + 'forms', (op, payload) => call(op, 'A', payload), expression => evaluate('A', expression))
    console.log(`PASS: packed Electron (${mode}): keyboard defaults, selection, editable focus, scoped reading, CSS waits and POST forms`)
  } finally {
    const child = client.child
    const exited = child && child.exitCode === null && child.signalCode === null && once(child, 'exit').catch(() => {})
    client.dispose()
    if (exited) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      try { await exited } finally { clearTimeout(timer) }
    }
  }
}

async function checkToolbar(url) {
  const driver = fileURLToPath(new URL('../test/helpers/toolbar-electron.cjs', import.meta.url))
  const env = { ...process.env, BROWSER_USE_TOKEN: 'local-toolbar-test', BROWSER_USE_USER_DATA_DIR: join(root, 'toolbar') }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [driver, resolve(directory), url], { env, stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
  const exited = once(child, 'exit')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000)
  const output = createInterface({ input: child.stdout })
  let socket
  let nextId = 0
  const awaited = new Map()
  const send = message => {
    const id = nextId++
    socket.write(JSON.stringify({ id, conversationId: 'toolbar', ...message }) + '\n')
    return id
  }
  try {
    child.on('message', ({ sequence, op, payload }) => {
      awaited.set(send({ op, ...payload }), sequence)
    })
    for await (const line of output) {
      if (!line.trim()) continue
      if (socket) { console.log(line); continue }
      const { port } = JSON.parse(line)
      socket = connect(port, '127.0.0.1')
      await once(socket, 'connect')
      socket.on('error', () => {}) // the test process may exit before the final RPC reply
      createInterface({ input: socket }).on('line', response => {
        const { id, ok, result, error } = JSON.parse(response)
        if (awaited.has(id) && child.connected) child.send({ sequence: awaited.get(id), ok, result, error })
        awaited.delete(id)
      })
      send({ op: 'hello', token: env.BROWSER_USE_TOKEN })
      send({ op: 'state' })
    }
    const [code, signal] = await exited
    assert.equal(code, 0, 'toolbar Electron exited: ' + (signal || code))
  } finally {
    clearTimeout(timeout)
    socket?.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
}

async function checkTabs(url, call) {
  const source = await call('navigate', { url: url + 'forms' })
  const first = source.tabId
  const evaluate = async (tabId, expression) => {
    const result = await call('eval', { tabId, expression })
    assert.equal(result.ok, true, result.exception)
    return result.value
  }
  async function backgroundPixel(tabId) {
    const shot = await call('screenshot', { tabId })
    const pixel = await evaluate(tabId, `(async () => {
      const image = new Image()
      image.src = 'data:image/jpeg;base64,${shot.base64}'
      await image.decode()
      const ctx = document.createElement('canvas').getContext('2d')
      const x = Math.floor(image.naturalWidth * 0.9)
      const y = Math.floor(image.naturalHeight * 0.9)
      ctx.drawImage(image, x, y, 1, 1, 0, 0, 1, 1)
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
    })()`)
    return JSON.parse(pixel)
  }
  await evaluate(first, `document.body.style.background = 'rgb(17, 85, 170)'; localStorage.setItem('tab-token', 'test');
    ordinary.onclick = () => { window.clickCount = (window.clickCount || 0) + 1 }`)
  const original = await backgroundPixel(first)
  assert.ok(original[2] > original[0] + 60, 'expected a blue first tab: ' + original)
  const second = (await call('tabs', { action: 'new' })).activeTabId
  await call('navigate', { tabId: second, url })
  assert.equal(await evaluate(second, "localStorage.getItem('tab-token')"), 'test')
  await evaluate(second, "document.body.style.background = 'rgb(240, 20, 60)'")
  await call('click', { tabId: first, ref: source.elements.find(item => item.selector === '#ordinary').ref })
  assert.equal(await evaluate(first, 'window.clickCount'), '1')
  await call('type', { tabId: first, ref: source.elements.find(item => item.selector === '#field').ref, text: 'kept', mode: 'fast' })
  assert.equal(await evaluate(first, 'field.value'), 'kept')
  assert.equal((await call('tabs', { action: 'list' })).activeTabId, second)
  const selected = await backgroundPixel(second)
  assert.ok(selected[0] > selected[2] + 60, 'expected a red selected tab: ' + selected)
  const inactive = await backgroundPixel(first)
  // Compare the same surface across the tab switch using this runner's color pipeline.
  assert.ok(inactive.every((channel, i) => Math.abs(channel - original[i]) < 8),
    `inactive screenshot changed: original=${original}, inactive=${inactive}, selected=${selected}`)
  assert.equal((await call('tabs', { action: 'list' })).activeTabId, second)
  assert.equal((await call('windowState')).focused, false)
  await call('tabs', { action: 'close', tabId: second })

  await evaluate(first, `window.open(${JSON.stringify(url)}, '_blank'); true`)
  const popup = await until(async () => {
    const state = await call('tabs', { action: 'list' })
    return state.activeTabId !== first && state.activeTabId
  })
  await call('wait', { tabId: popup, selector: '#code' })
  await evaluate(popup, "document.querySelector('#code').value = 'popup draft'")
  await call('tabs', { action: 'close', tabId: first })
  assert.equal(await evaluate(popup, "document.querySelector('#code').value"), 'popup draft')
}

async function checkForms(url, call, evaluate) {
  const page = await call('navigate', { url })
  const ref = selector => page.elements.find(item => item.selector === selector).ref
  await assert.rejects(call('insertText', { text: 'x' }), /focused editable/)
  await evaluate('locked.focus()')
  await assert.rejects(call('insertText', { text: 'x' }), /focused editable/)
  assert.equal(await evaluate('locked.value'), '')
  for (const mode of ['human', 'fast']) {
    await evaluate("field.focus(); field.value = 'abc'; field.setSelectionRange(1, 2)")
    assert.equal((await call('type', { ref: ref('#field'), text: 'XY', mode })).typed, 2)
    assert.equal(await evaluate('field.value'), 'aXYc')
  }
  await call('key', { key: 'Enter' })
  assert.equal(await evaluate('window.submits'), '1')
  await evaluate('editor.focus()')
  await call('key', { key: 'Space' })
  await call('key', { key: 'Enter' })
  assert.equal(await evaluate('editor.value'), ' \n')
  await call('insertText', { text: 'ok' })
  assert.equal(await evaluate('editor.value'), ' \nok')
  await evaluate("editor.addEventListener('keydown', e => e.preventDefault(), { once: true })")
  await call('key', { key: 'Space' })
  assert.equal(await evaluate('editor.value'), ' \nok')
  await evaluate('rich.focus()')
  await call('insertText', { text: 'rich' })
  await evaluate('ordinary.focus()')
  await assert.rejects(call('insertText', { text: 'oops' }), /focused editable/)
  assert.equal(await evaluate('rich.textContent'), 'rich')
  await evaluate("window.shadowField = document.createElement('textarea'); shadowHost.attachShadow({ mode: 'closed' }).append(shadowField); shadowField.focus()")
  await call('insertText', { text: 'shadow' })
  assert.equal(await evaluate('shadowField.value'), 'shadow')
  await evaluate("child.contentDocument.querySelector('textarea').focus()")
  await call('insertText', { text: 'frame' })
  assert.equal(await evaluate("child.contentDocument.querySelector('textarea').value"), 'frame')

  const first = await call('read', { selector: '#region', maxChars: 5 })
  assert.equal(first.text, 'Lead ')
  const rest = await call('read', { cursor: first.nextCursor })
  assert.equal(rest.text, 'visible tail')
  assert.equal((await call('read', { selector: '#hidden-region' })).text, '')
  await assert.rejects(call('wait', { selector: '[' }), /selector/i)
  assert.equal((await call('wait', { selector: '.absent', timeoutMs: 250 })).ready, false)

  const sourceTab = (await call('tabs', { action: 'list' })).activeTabId
  for (const encoding of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data', 'empty']) {
    const formPage = await call('navigate', { url })
    if (encoding === 'empty') await evaluate('payload.disabled = true')
    else await evaluate('payload.form.enctype = ' + JSON.stringify(encoding))
    await evaluate("field.value = 'unsaved draft'")
    const count = submissions.length
    await call('click', { ref: formPage.elements.find(item => item.selector === '#post').ref })
    await until(async () => (await call('state')).title === 'Form received')
    const { activeTabId, tabs } = await call('tabs', { action: 'list' })
    assert.equal(tabs.length, 2)
    assert.notEqual(activeTabId, sourceTab)
    const draft = await call('eval', { tabId: sourceTab, expression: 'field.value' })
    assert.equal(draft.value, 'unsaved draft')
    await call('tabs', { action: 'close', tabId: activeTabId })
    assert.equal((await call('tabs', { action: 'list' })).activeTabId, sourceTab)
    assert.equal(submissions.length, count + 1)
    const { method, headers, body } = submissions.at(-1)
    assert.equal(method, 'POST')
    assert.equal(headers.referer, url)
    if (encoding === 'multipart/form-data') {
      const boundary = /^multipart\/form-data;\s*boundary=(.+)$/.exec(headers['content-type'])?.[1]
      assert.ok(boundary)
      assert.ok(body.startsWith('--' + boundary + '\r\n'))
      assert.ok(body.endsWith('--' + boundary + '--\r\n'))
      assert.match(body, /name="term"\r\n\r\na & b\r\n/)
    } else {
      assert.equal(headers['content-type'], encoding === 'empty' ? 'application/x-www-form-urlencoded' : encoding)
      assert.equal(body, encoding === 'empty' ? '' : encoding === 'text/plain' ? 'term=a & b\r\n' : 'term=a+%26+b')
    }
  }
}

try {
  // Register the event promise before listen in case an immediate startup error is emitted.
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const url = `http://127.0.0.1:${server.address().port}/`
  await smoke('shared', url)
  await smoke('isolated', url)
  await checkToolbar(url)
} finally {
  server.closeAllConnections()
  server.close()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
}
