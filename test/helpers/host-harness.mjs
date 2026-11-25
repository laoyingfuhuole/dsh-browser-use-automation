import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { sep } from 'node:path'
import vm from 'node:vm'

const source = readFileSync(new URL('../../host/main.cjs', import.meta.url), 'utf8')
const require = createRequire(import.meta.url)

export function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// A minimal DOM executes the actual snapshot/target scripts; this is not a layout engine.
function createPage() {
  class HTMLElement {
    getClientRects() { return [{}] }
    closest() { return null }
    matches(selector) { return selector === ':disabled' && this.disabled === true }
  }
  const document = { title: 'Fixture', readyState: 'complete', activeElement: null }
  const location = { href: 'https://example.test/' }
  const element = Object.assign(new HTMLElement(), {
    tagName: 'INPUT', type: 'text', id: 'field', value: '', isConnected: true,
    ownerDocument: document, style: {},
    getAttribute(name) { return name === 'name' ? 'field' : null },
    matches(selector) { return selector === ':disabled' ? this.disabled === true : true },
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 30 } },
    scrollIntoView() {}, contains(node) { return node === this }, closest() { return null },
    focus() { document.activeElement = this },
  })
  document.body = Object.assign(new HTMLElement(), { innerText: 'Fixture page', appendChild() {} })
  document.documentElement = document.body
  document.querySelectorAll = () => [element]
  document.querySelector = () => element
  document.elementFromPoint = () => element
  document.getElementById = () => null
  document.createElement = () => { throw new Error('Decorative cursor DOM intentionally not modeled') }
  const context = vm.createContext({
    document, location, HTMLElement, CSS: { escape: text => text },
    getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', ...node.style }),
  })
  return { context, document, location, element }
}

export async function createHostHarness(t, { platform = 'linux', authenticate = true, env = {}, existingFiles = [] } = {}) {
  const natives = []
  const timeouts = new Map()
  const intervals = new Map()
  const responses = []
  const output = []
  const ipcMain = new EventEmitter()
  const filesystem = {
    directories: [], files: new Map(existingFiles),
    mkdirSync(path) { this.directories.push(path) },
    rmSync(path) {
      this.directories = this.directories.filter(directory => directory !== path)
      for (const file of this.files.keys()) if (file.startsWith(path + sep)) this.files.delete(file)
    },
    opendirSync(path) {
      const entries = new Map()
      for (const [key, directory] of [...this.directories.map(key => [key, true]), ...[...this.files.keys()].map(key => [key, false])]) {
        if (!key.startsWith(path + sep)) continue
        const relative = key.slice(path.length + 1).split(sep)
        const isDirectory = directory || relative.length > 1
        const name = relative[0]
        entries.set(name, { name, isDirectory: () => isDirectory, isFile: () => !isDirectory, isSymbolicLink: () => false })
      }
      if (!entries.size && !this.directories.includes(path)) throw Object.assign(new Error('directory missing'), { code: 'ENOENT' })
      const iterator = entries.values()
      return { readSync: () => iterator.next().value, closeSync() {} }
    },
    mkdtempSync(prefix) { const path = prefix + String(this.directories.length); this.directories.push(path); return path },
    statSync(path) {
      if (!this.files.has(path)) throw new Error('fixture file missing')
      return { isFile: () => true, size: this.files.get(path) }
    },
    writeFileSync(path, bytes) { this.files.set(path, bytes.length) },
    realpathSync: path => path,
    accessSync() {},
    constants: { R_OK: 4 },
  }
  const app = Object.assign(new EventEmitter(), {
    quitCalls: 0, quit() { this.quitCalls++ },
    whenReady: () => Promise.resolve(), setAppUserModelId() {}, isActive: () => false,
    focusCalls: 0, focus() { this.focusCalls++ },
    getPath: name => name === 'home' ? '/fixture/home' : '/fixture/' + name,
  })
  function makeSession() {
    return Object.assign(new EventEmitter(), {
      flushes: 0, cleanups: 0, flushStorageData() { this.flushes++ }, cookies: { async flushStore() {} },
      registerPreloadScript(value) { this.preload = value; return 'fixture-preload' },
      unregisterPreloadScript() { delete this.preload },
      setPermissionCheckHandler(handler) { this.permissionCheck = handler },
      setPermissionRequestHandler(handler) { this.permissionRequest = handler },
      async closeAllConnections() {}, async clearCache() {}, async clearData() { this.cleanups++ },
    })
  }
  const defaultSession = makeSession()
  const partitions = new Map()
  const session = { defaultSession, fromPartition(name) {
    if (!partitions.has(name)) partitions.set(name, makeSession())
    return partitions.get(name)
  } }
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super()
      this.id = natives.length + 1
      this.options = options
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
      this.page = createPage()
      this.commands = []
      this.visible = false
      this.focused = false
      this.destroyed = false
      this.opacity = 1
      this.focusCalls = 0
      this.focusable = options.focusable ?? true
      this.mouseIgnored = false
      this.lifecycleCalls = []
      const contents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler(handler) { this.openHandler = handler },
        focusedFrame: { executeJavaScript: async source => vm.runInContext(source, this.page.context) },
        getURL: () => this.page.location.href,
        printToPDF: async () => Buffer.from('%PDF-1.7\nfixture'),
      })
      const debuggerEvents = new EventEmitter()
      contents.debugger = {
        on: debuggerEvents.on.bind(debuggerEvents),
        emit: debuggerEvents.emit.bind(debuggerEvents),
        attach() {},
        sendCommand: async (method, params = {}) => {
          this.commands.push({ method, params })
          const override = this.onCommand?.(method, params)
          if (override !== undefined) {
            const result = await override
            this.recordCommandEffect(method, params)
            return result
          }
          if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: this.options.width - 100, clientHeight: this.options.height - 100 } }
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'fixture-frame', url: this.page.location.href } } }
          if (method === 'Runtime.evaluate') {
            try { return { result: { value: await vm.runInContext(params.expression, this.page.context, { timeout: 1000 }) } } }
            catch (error) { return { exceptionDetails: { text: error.message } } }
          }
          this.recordCommandEffect(method, params)
          return {}
        },
      }
      this.recordCommandEffect = (method, params) => {
        if (method === 'Input.insertText') this.page.element.value += params.text
        if (method === 'Input.dispatchKeyEvent') {
          const events = this.page.keyEvents ??= []
          events.push(params)
        }
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseWheel') {
          const wheels = this.page.wheels ??= []
          wheels.push(params)
        }
      }
      this.webContents = contents
      natives.push(this)
    }
    async loadURL(url) {
      this.lifecycleCalls.push({ action: 'loadURL', focusable: this.focusable, mouseIgnored: this.mouseIgnored })
      this.page.location.href = url
    }
    isDestroyed() { return this.destroyed }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); this.webContents.emit('destroyed') }
    isVisible() { return this.visible }
    isFocused() { return this.focused }
    isMinimized() { return false }
    getOpacity() { return this.opacity }
    setOpacity(value) { this.opacity = value; this.lifecycleCalls.push({ action: 'opacity', value }) }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }) }
    getBounds() { return { ...this.bounds } }
    setBounds(bounds) { this.bounds = bounds }
    getTitle() { return this.options.title }
    setSkipTaskbar() {}
    setFocusable(value) { this.focusable = value; this.lifecycleCalls.push({ action: 'focusable', value }) }
    setIgnoreMouseEvents(value) { this.mouseIgnored = value }
    setMinimizable() {}
    showInactive() {
      this.visible = true
      this.lifecycleCalls.push({ action: 'showInactive', focusable: this.focusable, opacity: this.opacity })
    }
    show() { this.visible = true }
    focus() { this.focusCalls++; this.focused = true }
    blur() { this.focused = false; this.lifecycleCalls.push({ action: 'blur' }) }
    restore() {
      this.lifecycleCalls.push({ action: 'restore', focusable: this.focusable, opacity: this.opacity })
      // 模拟可聚焦窗口在原生恢复时重新取得焦点；仅检查最终 focus 状态会漏掉这个瞬时回归。
      if (this.focusable) this.focus()
    }
  }
  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 }, bounds: { x: 0, y: 0, width: 1440, height: 900 } }
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => display, getAllDisplays: () => [display] })
  let accept
  const server = Object.assign(new EventEmitter(), {
    listen(port, host, callback) { this.bind = { port, host }; callback() },
    address: () => ({ port: 12345 }),
  })
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return { app, BrowserWindow, screen, ipcMain, session, Menu: { buildFromTemplate: items => items } }
      if (name === 'node:net') return { createServer(handler) { accept = handler; return server } }
      if (name === 'node:fs') return {
        mkdirSync: path => filesystem.mkdirSync(path),
        mkdtempSync: path => filesystem.mkdtempSync(path),
        statSync: path => filesystem.statSync(path),
        lstatSync: path => filesystem.statSync(path),
        opendirSync: path => filesystem.opendirSync(path),
        rmSync: path => filesystem.rmSync(path),
        writeFileSync: (...args) => filesystem.writeFileSync(...args),
        realpathSync: path => filesystem.realpathSync(path),
        accessSync: (...args) => filesystem.accessSync(...args),
        constants: filesystem.constants,
      }
      if (name === './native-ui.cjs' || name === './download-quota.cjs') {
        const module = { exports: {} }
        const body = readFileSync(new URL(`../../host/${name.slice(2)}`, import.meta.url), 'utf8')
        vm.runInContext(`(function(require,module,exports,__dirname) { ${body}\n })`, context)(context.require, module, module.exports, '/fixture/host')
        return module.exports
      }
      if (name === '../src/components.json') return JSON.parse(readFileSync(new URL('../../src/components.json', import.meta.url), 'utf8'))
      if (name === 'node:path' || name === 'node:crypto') return require(name)
      throw new Error(`Unexpected host import: ${name}`)
    },
    process: { env: { BROWSER_USE_TOKEN: 'fixture-token', ...env }, platform, pid: 123, on() {}, stdout: { write: line => output.push(line) } },
    console: { ...console, error: (...args) => output.push(args.join(' ')) }, URL, Buffer,
    setTimeout(callback, ms) { const id = {}; timeouts.set(id, { callback, ms }); return id },
    clearTimeout(id) { timeouts.delete(id) },
    setInterval(callback) { const id = { unref() {} }; intervals.set(id, callback); return id },
    clearInterval(id) { intervals.delete(id) },
  })
  vm.runInContext(source + '\n;globalThis.fixture = { windows, requests, quitHost }', context, { filename: 'host/main.cjs' })
  const state = context.fixture
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve() }
  await flush()
  function socket() {
    return Object.assign(new EventEmitter(), {
      destroyed: false, setEncoding() {},
      write(line) { responses.push(JSON.parse(line)) },
      destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close') } },
    })
  }
  const connection = socket()
  accept(connection)
  const send = value => connection.emit('data', JSON.stringify(value) + '\n')
  if (authenticate) send({ id: 0, op: 'hello', token: 'fixture-token' })
  let nextId = 1
  const h = {
    ...state, app, ipcMain, natives, responses, output, server, connection, defaultSession, filesystem, timeouts, intervals, flush,
    send, accept, socket,
    submit(op, conversationId = 'A', payload = {}) {
      const id = nextId++
      send({ ...payload, id, op, conversationId })
      return id
    },
    response(id) { return responses.find(item => item.id === id) },
    async run(op, conversationId = 'A', payload = {}) {
      const id = this.submit(op, conversationId, payload)
      for (let attempt = 0; attempt < 20 && !this.response(id); attempt++) await flush()
      const response = this.response(id)
      assert.ok(response, `missing response for ${op} ${id}`)
      return response
    },
    cancel(id, conversationId = 'A') { send({ op: 'cancel', requestId: id, conversationId }) },
    fire(ms) {
      for (const [id, timer] of [...timeouts]) if (timer.ms === ms) { timeouts.delete(id); timer.callback() }
    },
  }
  t.after(async () => {
    state.quitHost()
    await flush()
    assert.equal(state.requests.size, 0)
    assert.equal(timeouts.size, 0, 'all host request and delay timers must be released')
    assert.equal(intervals.size, 0, 'all window watchers must be released')
  })
  return h
}
