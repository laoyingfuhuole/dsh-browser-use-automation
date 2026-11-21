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
const server = createServer((request, response) => {
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
  const client = new HostClient({ components: ['basic', 'files', 'eval', 'requests'] })
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
