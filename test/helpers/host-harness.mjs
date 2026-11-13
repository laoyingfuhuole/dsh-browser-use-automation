import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
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
  }
  const document = { title: 'Fixture', readyState: 'complete', activeElement: null }
  const location = { href: 'https://example.test/' }
  const element = Object.assign(new HTMLElement(), {
    tagName: 'INPUT', type: 'text', id: 'field', value: '', isConnected: true,
    ownerDocument: document, style: {},
    getAttribute(name) { return name === 'name' ? 'field' : null },
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

export async function createHostHarness(t, { platform = 'linux', authenticate = true } = {}) {
  const natives = []
  const timeouts = new Map()
  const intervals = new Map()
  const responses = []
  const output = []
  const app = Object.assign(new EventEmitter(), {
    quitCalls: 0, quit() { this.quitCalls++ },
    whenReady: () => Promise.resolve(), setAppUserModelId() {}, isActive: () => false,
  })
  const defaultSession = { flushes: 0, flushStorageData() { this.flushes++ }, cookies: { async flushStore() {} } }
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
      const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler(handler) { this.openHandler = handler } })
      contents.debugger = {
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
    async loadURL(url) { this.page.location.href = url }
    isDestroyed() { return this.destroyed }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); this.webContents.emit('destroyed') }
    isVisible() { return this.visible }
    isFocused() { return this.focused }
    isMinimized() { return false }
    getOpacity() { return this.opacity }
    setOpacity(value) { this.opacity = value }
    setPosition(x, y) { Object.assign(this.bounds, { x, y }) }
    getBounds() { return { ...this.bounds } }
    setBounds(bounds) { this.bounds = bounds }
    getTitle() { return this.options.title }
    setSkipTaskbar() {}
    setFocusable() {}
    setIgnoreMouseEvents() {}
    setMinimizable() {}
    showInactive() { this.visible = true }
    show() { this.visible = true }
    focus() { this.focusCalls++; this.focused = true }
    blur() { this.focused = false }
    restore() {}
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
      if (name === 'electron') return { app, BrowserWindow, screen, session: { defaultSession }, Menu: { buildFromTemplate: items => items } }
      if (name === 'node:net') return { createServer(handler) { accept = handler; return server } }
      if (name === 'node:fs') return { mkdirSync() { throw new Error('No profile writes permitted') } }
      if (name === 'node:path' || name === 'node:crypto') return require(name)
      throw new Error(`Unexpected host import: ${name}`)
    },
    process: { env: { BROWSER_USE_TOKEN: 'fixture-token' }, platform, pid: 123, on() {}, stdout: { write: line => output.push(line) } },
    console, URL, Buffer,
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
    ...state, app, natives, responses, output, server, connection, defaultSession, timeouts, intervals, flush,
    send, accept, socket,
    submit(op, conversationId = 'A', payload = {}) {
      const id = nextId++
      send({ ...payload, id, op, conversationId })
      return id
    },
    response(id) { return responses.find(item => item.id === id) },
    async run(op, conversationId = 'A', payload = {}) {
      const id = this.submit(op, conversationId, payload)
      await flush()
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
