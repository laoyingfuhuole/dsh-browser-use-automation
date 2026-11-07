'use strict'

/**
 * The browser host: one Electron window, one CDP session, one authenticated
 * line-delimited JSON-RPC channel to the DSH plugin.
 *
 * The window is created hidden, then shown without activation at opacity 0 and
 * parked offscreen. It is never focused or raised by a tool. CDP input and
 * capture still work because the window keeps a display surface.
 */

const { app, BrowserWindow, Menu, screen } = require('electron')
const { createServer } = require('node:net')

const TOKEN = process.env.BROWSER_USE_TOKEN || ''
const WIDTH = Number(process.env.BROWSER_USE_WIDTH || 1400) || 1400
const HEIGHT = Number(process.env.BROWSER_USE_HEIGHT || 900) || 900
const FORCE_DOCK = process.env.BROWSER_USE_KEEP_DOCK === '1'
const HIDE_DOCK = process.env.BROWSER_USE_HIDE_DOCK === '1' && FORCE_DOCK !== true

let win = null
let server = null
let socket = null
let input = ''
let authenticated = false
let quitting = false
let refs = new Map()
let queue = Promise.resolve()
let revealReady = false

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function send(message) {
  if (socket === null || socket.destroyed) return
  socket.write(`${JSON.stringify(message)}\n`)
}

async function cdp(method, params = {}) {
  return win.webContents.debugger.sendCommand(method, params)
}

async function evaluate(expression, extra = {}) {
  const response = await cdp('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    ...extra,
  })
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
    throw new Error(description || response.exceptionDetails.text || 'page evaluation failed')
  }
  return response.result ? response.result.value : undefined
}

const SNAPSHOT_SCRIPT = `(() => {
  const selectors = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]'
  const visible = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width < 4 || rect.height < 4) return false
    const style = getComputedStyle(el)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }
  const labelOf = (el) => String(
    el.getAttribute('aria-label')
    || el.getAttribute('placeholder')
    || el.innerText
    || el.value
    || el.getAttribute('name')
    || el.id
    || el.tagName,
  ).replace(/\\s+/g, ' ').trim().slice(0, 120)
  const selectorOf = (el) => {
    if (el.id) return '#' + CSS.escape(el.id)
    const name = el.getAttribute('name')
    if (name) return el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]'
    return ''
  }
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll(selectors)) {
    if (seen.has(el) || !visible(el)) continue
    seen.add(el)
    const rect = el.getBoundingClientRect()
    out.push({
      kind: el.getAttribute('role') || el.tagName.toLowerCase(),
      label: labelOf(el),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      selector: selectorOf(el),
    })
    if (out.length >= 150) break
  }
  return {
    url: location.href,
    title: document.title,
    elements: out,
    truncated: out.length >= 150,
  }
})()`

async function snapshot() {
  const value = await evaluate(SNAPSHOT_SCRIPT)
  refs = new Map()
  for (let index = 0; index < value.elements.length; index += 1) {
    const element = value.elements[index]
    element.ref = index + 1
    refs.set(element.ref, { x: element.x, y: element.y, selector: element.selector })
  }
  return value
}

async function waitForReady(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const state = await evaluate('document.readyState')
      if (state === 'complete') return true
    } catch {
      // The page can be between documents; keep polling.
    }
    await delay(100)
  }
  return false
}

async function navigate(url) {
  const parsed = new URL(url)
  if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) {
    throw new Error(`unsupported URL protocol: ${parsed.protocol}`)
  }
  await cdp('Page.navigate', { url })
  await waitForReady()
  await delay(250)
  return snapshot()
}

const CURSOR_ID = '__dsh_browser_use_cursor__'

async function showCursor(x, y, label) {
  await evaluate(`(() => {
    const id = ${JSON.stringify(CURSOR_ID)}
    let host = document.getElementById(id)
    if (host === null) {
      host = document.createElement('div')
      host.id = id
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;'
      ;(document.documentElement || document.body).appendChild(host)
    }
    // Move the host first: even if a site blocks part of the decoration,
    // the cursor must still land on the action point.
    host.style.transform = 'translate3d(${Math.round(x)}px,${Math.round(y)}px,0)'
    try {
      let arrow = host.querySelector('[data-arrow]')
      if (arrow === null) {
        // Build nodes instead of innerHTML: some sites enforce Trusted Types,
        // where assigning a string to innerHTML throws and would leave an empty
        // cursor host behind.
        arrow = document.createElement('div')
        arrow.setAttribute('data-arrow', '')
        arrow.style.cssText = 'position:absolute;left:0;top:0;width:14px;height:20px;background:#111;clip-path:polygon(0 0,0 16px,4px 12px,7px 19px,10px 18px,7px 11px,13px 11px);filter:drop-shadow(0 1px 1px rgba(255,255,255,.9));'
        host.appendChild(arrow)
      }
    } catch {}
    try {
      let bubble = host.querySelector('[data-bubble]')
      if (bubble === null) {
        bubble = document.createElement('div')
        bubble.setAttribute('data-bubble', '')
        bubble.style.cssText = 'position:absolute;left:18px;top:14px;padding:3px 7px;border-radius:6px;background:#111;color:#fff;font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:12px;line-height:1.3;white-space:nowrap;opacity:.92;'
        host.appendChild(bubble)
      }
      bubble.textContent = ${JSON.stringify(String(label || 'click'))}
    } catch {}
    return true
  })()`).catch(() => {})
}

async function showRipple(x, y) {
  await evaluate(`(() => {
    const host = document.getElementById(${JSON.stringify(CURSOR_ID)})
    if (host === null) return false
    const ring = document.createElement('div')
    ring.style.cssText = 'position:absolute;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid #ff3b30;border-radius:50%;opacity:.9;'
    host.appendChild(ring)
    const animation = ring.animate(
      [{ transform: 'scale(.35)', opacity: .95 }, { transform: 'scale(1.6)', opacity: 0 }],
      { duration: 550, easing: 'cubic-bezier(.2,.7,.3,1)' },
    )
    animation.addEventListener('finish', () => ring.remove())
    return true
  })()`).catch(() => {})
}

async function click(ref) {
  const point = refs.get(Number(ref))
  if (point === undefined) throw new Error(`unknown snapshot ref: ${ref}; take a new snapshot first`)
  let target = point
  if (typeof point.selector === 'string' && point.selector.length > 0) {
    // The page can move an element between the snapshot and the click (a
    // suggestion popup, a layout shift, a sticky header). Resolve the live
    // rect instead of trusting stale coordinates; otherwise a real click lands
    // on whatever replaced the element.
    const live = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(point.selector)})
      if (element === null) return null
      element.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = element.getBoundingClientRect()
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    })()`).catch(() => null)
    if (live !== null && Number.isFinite(live.x) && Number.isFinite(live.y)) {
      target = { ...point, x: live.x, y: live.y }
    }
  }
  await showCursor(target.x, target.y, 'click')
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: target.x,
    y: target.y,
    button: 'left',
    clickCount: 1,
  })
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: target.x,
    y: target.y,
    button: 'left',
    clickCount: 1,
  })
  await showRipple(target.x, target.y)
  await delay(160)
  return { clicked: true, ref: Number(ref), x: Math.round(target.x), y: Math.round(target.y) }
}

async function type(ref, text) {
  const point = refs.get(Number(ref))
  if (point === undefined) throw new Error(`unknown snapshot ref: ${ref}; take a new snapshot first`)
  if (point.selector) {
    const focused = await evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(point.selector)})
      if (element === null) return false
      element.focus()
      return true
    })()`)
    if (focused !== true) {
      await click(ref)
    }
  } else {
    await click(ref)
  }
  const characters = Array.from(text)
  for (const character of characters) {
    await cdp('Input.insertText', { text: character })
    await delay(18)
  }
  const focusPoint = await evaluate(`(() => {
    const element = document.activeElement
    if (element === null) return null
    const rect = element.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`).catch(() => null)
  await showCursor(focusPoint?.x ?? point.x, focusPoint?.y ?? point.y, 'type')
  await delay(50)
  return { typed: characters.length }
}

async function screenshot() {
  const response = await cdp('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 80,
    fromSurface: true,
  })
  return { base64: response.data, mime: 'image/jpeg' }
}

async function waitFor(args) {
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 10_000, 250), 30_000)
  const deadline = Date.now() + timeoutMs
  const selector = typeof args.selector === 'string' ? args.selector : ''
  const text = typeof args.text === 'string' ? args.text : ''
  const url = typeof args.url === 'string' ? args.url : ''
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(`(() => {
        const body = document.body
        return {
          url: location.href,
          ready: document.readyState,
          has: ${selector ? `!!document.querySelector(${JSON.stringify(selector)})` : 'true'},
          text: ${text ? `(body ? body.innerText : '').includes(${JSON.stringify(text)})` : 'true'},
        }
      })()`)
      if (state.ready === 'complete' && state.has === true && state.text === true
        && (url === '' || state.url.startsWith(url))) {
        return { ready: true, reason: 'ok' }
      }
    } catch {
      // Navigation can replace the execution context mid-poll.
    }
    await delay(150)
  }
  return { ready: false, reason: `timeout after ${timeoutMs}ms` }
}

async function pageState() {
  return evaluate(`(() => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    bodyText: document.body ? document.body.innerText.slice(0, 400) : '',
  }))()`)
}

async function dispatch(message) {
  // A window the user revealed must not stay on screen after they switch away.
  // Tools never present the window; restore the background contract first.
  if (win !== null && !win.isDestroyed() && win.isVisible() && win.getOpacity() > 0 && !appActive()) {
    hideToBackground()
  }
  switch (message.op) {
    case 'navigate':
      return navigate(message.url)
    case 'snapshot':
      return snapshot()
    case 'click':
      return click(message.ref)
    case 'type':
      return type(message.ref, String(message.text ?? ''))
    case 'insertText':
      await cdp('Input.insertText', { text: String(message.text ?? '') })
      return { typed: String(message.text ?? '').length }
    case 'screenshot':
      return screenshot()
    case 'eval': {
      try {
        const value = await evaluate(message.expression)
        return { ok: true, value: typeof value === 'string' ? value : JSON.stringify(value ?? null) }
      } catch (error) {
        return { ok: false, exception: String(error && error.message ? error.message : error) }
      }
    }
    case 'wait':
      return waitFor(message)
    case 'state':
      return pageState()
    case 'windowShow':
      return revealWindow()
    case 'windowHide':
      return hideToBackground()
    case 'windowState':
      return {
        bounds: win.getBounds(),
        visible: win.isVisible(),
        focused: win.isFocused(),
        minimized: win.isMinimized(),
        opacity: win.getOpacity(),
        title: win.getTitle(),
      }
    case 'back':
      await evaluate('history.back()')
      await waitForReady(10_000)
      await delay(200)
      return snapshot()
    case 'reload':
      await cdp('Page.reload', { ignoreCache: false })
      await waitForReady(10_000)
      await delay(200)
      return snapshot()
    case 'close':
      quitting = true
      setTimeout(() => app.quit(), 30)
      return { closed: true }
    default:
      throw new Error(`unknown op: ${message.op}`)
  }
}

function onLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (authenticated !== true) {
    if (message.op !== 'hello' || message.token !== TOKEN) {
      socket.destroy()
      return
    }
    authenticated = true
    send({ id: message.id, ok: true, result: { pid: process.pid } })
    return
  }
  queue = queue.then(async () => {
    try {
      const result = await dispatch(message)
      send({ id: message.id, ok: true, result })
    } catch (error) {
      send({ id: message.id, ok: false, error: String(error && error.message ? error.message : error) })
    }
  })
}

function onConnection(connection) {
  if (socket !== null) {
    connection.destroy()
    return
  }
  socket = connection
  input = ''
  authenticated = false
  connection.setEncoding('utf8')
  connection.on('data', chunk => {
    input += chunk
    if (input.length > 8 * 1024 * 1024) {
      connection.destroy()
      return
    }
    let newline = input.indexOf('\n')
    while (newline >= 0) {
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (line.trim() !== '') onLine(line)
      newline = input.indexOf('\n')
    }
  })
  connection.on('error', () => {})
  connection.on('close', () => {
    if (socket === connection) socket = null
    quitting = true
    app.quit()
  })
}

function park() {
  if (win === null) return
  try {
    const bounds = win.getBounds()
    const area = screen.getPrimaryDisplay().workArea
    win.setPosition(area.x - bounds.width - 200, area.y + 33)
  } catch {
    // The window may be between native states during teardown.
  }
}

function appActive() {
  try {
    if (typeof app.isActive === 'function') return app.isActive()
  } catch {
    // Fall through to the window-focus fallback.
  }
  return win !== null && !win.isDestroyed() && win.isFocused()
}

function revealWindow() {
  if (win === null || win.isDestroyed()) return { shown: false, reason: 'no window' }
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(WIDTH, Math.max(480, area.width - 40))
  const height = Math.min(HEIGHT, Math.max(360, area.height - 40))
  win.setSkipTaskbar(false)
  win.setFocusable(true)
  try { win.setIgnoreMouseEvents(false) } catch {}
  win.setOpacity(1)
  win.setBounds({
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  })
  win.show()
  win.focus()
  app.dock?.show()
  app.focus({ steal: true })
  return { shown: true, bounds: win.getBounds(), opacity: win.getOpacity(), visible: win.isVisible() }
}

function hideToBackground() {
  if (win === null || win.isDestroyed()) return { hidden: false, reason: 'no window' }
  win.setSkipTaskbar(true)
  win.setFocusable(false)
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  win.setOpacity(0)
  win.showInactive()
  park()
  return { hidden: true, bounds: win.getBounds(), opacity: win.getOpacity(), visible: win.isVisible() }
}

async function start() {
  if (HIDE_DOCK) app.dock?.hide()
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    title: 'dsh-browser-use',
    skipTaskbar: true,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  // A page must never be able to open a second native window: keep it in this
  // single background surface. target=_blank links load in the current tab.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      win.loadURL(url).catch(() => {})
    }
    return { action: 'deny' }
  })
  win.webContents.on('did-create-window', child => {
    try { child.close() } catch {}
  })
  for (const other of BrowserWindow.getAllWindows()) {
    if (other !== win) {
      try { other.close() } catch {}
    }
  }
  win.on('close', event => {
    if (quitting !== true) {
      event.preventDefault()
      hideToBackground()
    }
  })
  win.on('minimize', () => {
    // The host must keep a surface. Restore silently; opacity/offscreen keep it hidden.
    setTimeout(() => {
      if (win === null || win.isDestroyed()) return
      win.restore()
      win.setFocusable(false)
      try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
      win.setOpacity(0)
      win.showInactive()
      park()
    }, 50)
  })
  win.on('blur', () => {
    // The user switched away (another app or the DSH chat): return to offscreen.
    // A click inside this page does not blur it, so watching the run still works.
    setTimeout(() => {
      if (win === null || win.isDestroyed()) return
      if (appActive() && win.isFocused()) return
      hideToBackground()
    }, 120)
  })
  await win.loadURL('about:blank')
  win.webContents.debugger.attach('1.3')
  await cdp('Page.enable')
  win.setSkipTaskbar(true)
  win.setFocusable(false)
  try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  try {
    win.setMinimizable(false)
  } catch {
    // Not every platform implements minimizability.
  }
  win.showInactive()
  win.setOpacity(0)
  park()
  revealReady = true
  // Fallback for focus transitions that do not emit blur (e.g. the window was
  // shown inactive and never became key). Keep the "shown" state self-cleaning.
  const watch = setInterval(() => {
    if (win === null || win.isDestroyed()) return
    if (win.isVisible() && win.getOpacity() > 0 && !appActive()) hideToBackground()
  }, 700)
  watch.unref?.()
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: '显示浏览器窗口', click: () => revealWindow() },
      { label: '隐藏到后台', click: () => hideToBackground() },
    ]))
  }
  server = createServer(onConnection)
  server.on('error', error => {
    console.error(`[dsh-browser-use] rpc server error: ${error.message}`)
    app.quit()
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    process.stdout.write(`${JSON.stringify({ port: address.port })}\n`)
  })
}

process.on('SIGTERM', () => {
  quitting = true
  app.quit()
})
process.on('SIGINT', () => {
  quitting = true
  app.quit()
})

app.whenReady().then(start).catch(error => {
  console.error(`[dsh-browser-use] host failed: ${error && error.stack ? error.stack : error}`)
  app.quit()
})
app.on('activate', () => {
  if (revealReady) revealWindow()
})
app.on('did-resign-active', () => {
  // macOS: the whole app lost focus; a visible window must not stay on top.
  setTimeout(() => {
    if (win === null || win.isDestroyed()) return
    if (win.isVisible() && win.getOpacity() > 0 && !appActive()) hideToBackground()
  }, 80)
})
app.on('window-all-closed', () => {
  // Keep the host alive until the parent disconnects or calls close.
})
