import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const source = readFileSync(new URL('../../src/client.js', import.meta.url), 'utf8')

// Link the real ESM module to in-memory dependencies; never spawn Electron or scan profiles.
export async function createClientHarness(t) {
  const children = []
  const sockets = []
  const timers = new Map()
  const env = { ELECTRON_PATH: '/test/electron', ELECTRON_RUN_AS_NODE: '1' }
  const context = vm.createContext({
    process: { env, platform: 'linux' }, Buffer, AbortController, URL,
    setTimeout(callback) { const token = {}; timers.set(token, callback); return token },
    clearTimeout(token) { timers.delete(token) },
  })
  function stream() {
    return Object.assign(new EventEmitter(), { setEncoding() {} })
  }
  const imports = {
    'node:child_process': { spawn(path, args, options) {
      const child = Object.assign(new EventEmitter(), {
        stdout: stream(), stderr: stream(), path, args, options, kills: [],
        kill(signal) { this.kills.push(signal) },
      })
      children.push(child)
      return child
    } },
    'node:module': { createRequire() { return { resolve() { throw new Error('No installed dependencies in fixture') } } } },
    'node:crypto': { randomBytes(size) { return Buffer.alloc(size, 1) } },
    'node:net': { connect(options) {
      const socket = Object.assign(stream(), {
        options, destroyed: false, writable: true, writes: [],
        write(line, callback) { this.writes.push(JSON.parse(line)); callback?.(); return true },
        destroy() { this.destroyed = true; this.emit('close') },
      })
      sockets.push(socket)
      return socket
    } },
    'node:fs': {
      accessSync() {}, constants: { F_OK: 0, X_OK: 1 }, existsSync() { return false },
      readFileSync() { throw new Error('Unexpected filesystem read') }, readdirSync() { return [] },
      statSync() { return { isFile: () => true } },
    },
    'node:os': { homedir: () => '/test/home' },
    'node:path': { dirname: () => '/test', join: (...parts) => parts.join('/') },
    'node:url': { fileURLToPath: () => '/test/host/main.cjs' },
    './integrity.js': { verifyInstallation() {} },
  }
  const module = new vm.SourceTextModule(source, {
    context, identifier: new URL('../../src/client.js', import.meta.url).href,
    initializeImportMeta(meta) { meta.url = new URL('../../src/client.js', import.meta.url).href },
  })
  await module.link(async specifier => {
    const exports = imports[specifier]
    if (!exports) throw new Error(`Unexpected import: ${specifier}`)
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
    }, { context })
  })
  await module.evaluate()
  const client = new module.namespace.HostClient({ width: 1200, height: 800 })
  t.after(() => {
    client.dispose()
    assert.equal(client.pending.size, 0)
    assert.equal(timers.size, 0, 'all request and startup timers must be released')
    for (const child of children) assert.equal(child.stdout.listenerCount('data'), 0)
  })
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return {
    client, children, sockets, timers, env, flush,
    expire() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback() },
    async connect() {
      children.at(-1).stdout.emit('data', '\r\n{"po')
      children.at(-1).stdout.emit('data', 'rt":12345}\r\n')
      await flush()
      const socket = sockets.at(-1)
      socket.emit('connect')
      await flush()
      return socket
    },
    async ready() {
      const starting = client.ensureStarted()
      const socket = await this.connect()
      socket.emit('data', '{"id":0,"ok":true,"result":{"pid":1}}\n')
      await starting
      return socket
    },
  }
}
