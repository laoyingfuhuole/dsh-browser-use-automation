import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
const server = createServer(async (request, response) => {
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
    await call('respond', 'A', { requestId: request.id, accept: false })
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

  for (const encoding of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data', 'empty']) {
    const formPage = await call('navigate', { url })
    if (encoding === 'empty') await evaluate('payload.disabled = true')
    else await evaluate('payload.form.enctype = ' + JSON.stringify(encoding))
    const count = submissions.length
    await call('click', { ref: formPage.elements.find(item => item.selector === '#post').ref })
    await until(async () => (await call('state')).title === 'Form received')
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
} finally {
  server.closeAllConnections()
  server.close()
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
}
