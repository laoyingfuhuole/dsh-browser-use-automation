'use strict'

/**
 * 浏览器宿主（Electron 主进程）：为每个对话管理独立的原生窗口、CDP 调试会话和操作队列，
 * 通过带令牌认证、每行一条 JSON 的 RPC 通道接收 DSH 插件的操作请求。
 *
 * “后台”不是 headless：窗口仍保有绘制表面，停在屏幕外且不主动激活。
 * macOS/Linux 透明且不可聚焦；Windows 为任务栏原生预览保留不透明表面和可激活性。
 * 普通页面操作不抢焦点；任务栏点击、Dock 菜单或显式 windowShow 才进入人工查看。
 *
 * 此文件的普通函数在主进程执行，没有 document；传给 evaluate 的脚本文本
 * 才在网页自己的 JavaScript 上下文执行，二者通过 CDP 传递可序列化的数据。
 */

const { app, BrowserWindow, Menu, screen, session } = require('electron')
const { createServer } = require('node:net')
const { randomBytes } = require('node:crypto')
const { mkdirSync } = require('node:fs')
const { isAbsolute } = require('node:path')

// 仅显式指定时改存储位置，且必须早于 ready；平时沿用现有默认资料和登录态。
const userDataDir = process.env.BROWSER_USE_USER_DATA_DIR
if (userDataDir !== undefined) {
  if (!isAbsolute(userDataDir)) throw new Error('BROWSER_USE_USER_DATA_DIR must be an absolute path')
  mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
  app.setPath('sessionData', userDataDir)
}

// 父进程通过环境变量配置本次宿主；KEEP_DOCK 显式覆盖 HIDE_DOCK。
const TOKEN = process.env.BROWSER_USE_TOKEN || ''
const WIDTH = Number(process.env.BROWSER_USE_WIDTH || 1400) || 1400
const HEIGHT = Number(process.env.BROWSER_USE_HEIGHT || 900) || 900
const FORCE_DOCK = process.env.BROWSER_USE_KEEP_DOCK === '1'
const HIDE_DOCK = process.env.BROWSER_USE_HIDE_DOCK === '1' && FORCE_DOCK !== true
const WINDOWS_TASKBAR = process.platform === 'win32'
// Windows 用同一个应用标识将本 host 的所有窗口归组；不创建系统托盘图标。
// 必须在创建任何窗口之前设置，且不修改 app 名称/数据目录，避免影响已有登录。
if (WINDOWS_TASKBAR) app.setAppUserModelId('laoyingfuhuole.dsh-browser-use')

// 宿主只保留一个控制连接；窗口、refs、CDP、就绪状态与队列均按对话隔离。
let server = null
let socket = null
let input = '' // TCP 可能拆包/粘包，先累积文本再按换行拆消息
let authenticated = false
let quitting = false
let sessionUsed = false
let nextWindowNumber = 0
let nextElementRef = 0 // host 内单调递增，快照更新及窗口重建都不复用旧编号。
let lastUse = 0
const windows = new Map()
// 一个连接内的请求表：取消通过 requestId 定位，同时校验 conversationId，不能跨对话。
const requests = new Map()
const REQUEST_TIMEOUT_MS = 60_000

function finishRequest(job, error, result) {
  if (job.done) return
  job.done = true
  clearTimeout(job.timer)
  requests.delete(job.message.id)
  job.record.jobs.delete(job)
  if (error) send({ id: job.message.id, ok: false, error: error.message || String(error) })
  else send({ id: job.message.id, ok: true, result })
}

function cancelRequest(job, error) {
  if (job.done) return
  job.error = error
  for (const stop of job.cancelWaiters) stop(error)
  finishRequest(job, error)
  // 这里不释放执行中的 CDP 屏障：它仍可能修改网页。只停止后续步骤；
  // 真正卡住时由用户明确选择 reset/close 销毁本窗口，不自动丢失多轮现场。
}
const operations = new Set([
  'navigate', 'snapshot', 'click', 'type', 'insertText', 'screenshot', 'eval',
  'wait', 'state', 'windowShow', 'windowHide', 'windowState', 'back', 'reload', 'close', 'reset',
])

function updateDockMenu() {
  if (quitting || process.platform !== 'darwin' || !app.dock) return
  app.dock.setMenu(Menu.buildFromTemplate(Array.from(windows.values(), record => ({
    label: `浏览器窗口 #${record.windowNumber}`,
    enabled: record.isReady(),
    submenu: [
      { label: '显示浏览器窗口', click: () => record.revealWindow() },
      { label: '隐藏到后台', click: () => record.hideToBackground() },
    ],
  }))))
}

function quitHost() {
  if (quitting) return
  quitting = true
  for (const record of windows.values()) record.dispose(new Error('host shutting down'))
  if (!sessionUsed) {
    app.quit()
    return
  }
  // Cookie 有写盘缓冲；正常退出前刷新共享默认 Session，快速重启也不丢已写数据。
  // 不修改应用名称、默认目录或分区，也不会把会话 Cookie 改成持久 Cookie。
  Promise.resolve().then(async () => {
    session.defaultSession.flushStorageData()
    await session.defaultSession.cookies.flushStore()
  }).catch(error => {
    console.error(`[dsh-browser-use] session flush failed: ${error.message}`)
  }).finally(() => app.quit())
}

function send(message) {
  if (socket === null || socket.destroyed) return
  // 换行是协议帧边界；JSON.stringify 会把字符串内的换行编码进 JSON。
  socket.write(`${JSON.stringify(message)}\n`)
}

// 闭包把所有 await 前后的页面操作固定在同一个窗口；没有全局“当前窗口”。
function createConversation(conversationId) {
  const windowNumber = ++nextWindowNumber
  const title = `dsh-browser-use #${windowNumber}`
  let win = null
  let refs = new Map()
  let documentVersion = 0
  const elementRegistryKey = '__dsh_refs_' + randomBytes(16).toString('hex')
  function invalidateRefs() { refs.clear(); documentVersion += 1 }
  let revealReady = false
  let disposed = false
  // 原生关闭意图只属于这一代记录；RPC close/reset、初始化失败和宿主退出
  // 均不设置它，避免程序销毁最后一个窗口时误把可复用的宿主也退出。
  let nativeCloseRequested = false
  let failure = null
  let watch = null
  let activeJob = null
  // Windows 为原生缩略图保留不透明绘制表面，不能再以 opacity 判断是否在人工查看。
  // transitioning 防止内部恢复/隐藏触发的 focus 被当作用户点击任务栏预览。
  let backgrounded = true
  let transitioning = false
  const timers = new Set()
  const pending = new Set()
  const record = {
    windowNumber, conversationId, lastUsed: ++lastUse, queue: Promise.resolve(),
    ready: null, dispatch, assertLive, dispose, isReady, revealWindow, hideToBackground,
    jobs: new Set(),
    async execute(job) {
      activeJob = job
      try {
        assertOperation()
        return await dispatch(job.message)
      } finally { activeJob = null }
    },
    onDisplaysChanged() {
      if (WINDOWS_TASKBAR && isReady() && backgrounded) {
        win.setOpacity(park() ? 1 : 0)
      }
    },
    onResign() {
      schedule(() => {
        if (isReady() && win.isVisible() && (WINDOWS_TASKBAR ? !backgrounded : win.getOpacity() > 0) && !appActive()) hideToBackground()
      }, 80)
    },
  }

  function assertLive() {
    if (disposed) throw failure
    if (win !== null && win.isDestroyed()) {
      dispose()
      throw failure
    }
  }

  function assertOperation() {
    assertLive()
    if (activeJob?.error) throw activeJob.error
  }

  function isReady() {
    return !disposed && revealReady && win !== null && !win.isDestroyed()
  }

  function schedule(callback, ms) {
    if (disposed) return
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (!disposed) callback()
    }, ms)
    timers.add(timer)
  }

  async function whileLive(operation) {
    assertLive()
    let rejectClosed
    const closed = new Promise((_resolve, reject) => { rejectClosed = reject })
    pending.add(rejectClosed)
    try {
      const result = await Promise.race([Promise.resolve().then(() => {
        assertLive()
        return operation()
      }), closed])
      assertLive()
      return result
    } finally {
      // 完成的操作立即取消销毁监听，避免长期开着的窗口积累 Promise 回调。
      pending.delete(rejectClosed)
    }
  }

  function delay(ms) {
    assertOperation()
    const job = activeJob
    return whileLive(() => new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        timers.delete(timer)
        job?.cancelWaiters.delete(finish)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(), ms)
      timers.add(timer)
      job?.cancelWaiters.add(finish)
      if (job?.error) finish(job.error)
    }))
  }

  function dispose(error = new Error('conversation window closed')) {
    if (disposed) return
    disposed = true
    failure = error
    for (const job of record.jobs) cancelRequest(job, error)
    revealReady = false
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    if (watch !== null) clearInterval(watch)
    refs.clear()
    for (const reject of pending) reject(error)
    pending.clear()
    // 旧窗口的延迟事件不得删除同一对话后来创建的新记录。
    if (windows.get(conversationId) === record) windows.delete(conversationId)
    if (win !== null && !win.isDestroyed()) win.destroy()
    updateDockMenu()
  }

  // CDP（Chrome DevTools Protocol）经 Electron 的 debugger 接口控制当前页面，
  // 不依赖系统鼠标、键盘或把原生窗口切到前台。
  async function cdp(method, params = {}, navigationCommand = false) {
    assertOperation()
    const response = await whileLive(() => {
      assertOperation()
      return win.webContents.debugger.sendCommand(method, params)
    })
    if (!navigationCommand) assertOperation()
    return response
  }

  // expression 是要交给网页执行的源码。returnByValue 取回值而非远程对象句柄；
  // awaitPromise 等待网页 Promise。网页异常转为主进程异常，再由 RPC 层处理。
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

  // 整个模板字符串会在网页里执行：收集可交互、具有可见尺寸的元素，
  // 返回标签、视口坐标和可选选择器，不尝试跨进程传递 DOM 节点。
  // 最多收集 150 项；这是一份操作快照，不是完整的 DOM/无障碍树。
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
    const nodes = new Map()
    // Map 保存实际 DOM 节点，不能用旧 selector 再匹配“长得一样”的替代节点。
    Object.defineProperty(globalThis, REGISTRY_KEY, { value: nodes, configurable: true })
    const seen = new Set()
    for (const el of document.querySelectorAll(selectors)) {
      if (seen.has(el) || !visible(el)) continue
      seen.add(el)
      const rect = el.getBoundingClientRect()
      const ref = FIRST_REF + out.length
      nodes.set(ref, el)
      out.push({
        ref,
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

  // 数字 ref 只属于这个窗口的最近快照；任何新快照、主框架导航都会使旧 ref 失效。
  async function snapshot() {
    refs.clear()
    const version = documentVersion
    const firstRef = nextElementRef + 1
    nextElementRef += 150
    if (!Number.isSafeInteger(nextElementRef)) throw new Error('snapshot ref space exhausted; restart host')
    const script = SNAPSHOT_SCRIPT.replace('REGISTRY_KEY', JSON.stringify(elementRegistryKey)).replace('FIRST_REF', String(firstRef))
    const value = await evaluate(script)
    assertOperation()
    if (version !== documentVersion) throw new Error('page changed during snapshot; take a new snapshot')
    for (const element of value.elements) refs.set(element.ref, true)
    return value
  }

  // 先监听主框架加载再发导航命令，不能把旧页面的 readyState=complete 当成新页面成功。
  // Promise 提前失败时先记录结果；仍等正在发送的 CDP 返回，避免旧命令与下一项交错。
  async function navigateAndWait(command, timeoutMs) {
    assertOperation()
    invalidateRefs()
    const contents = win.webContents
    const job = activeJob
    let started = false
    let settled = false
    let httpError = null
    let stopped = false
    const addresses = new Set()
    let resolveNavigation, rejectNavigation
    const navigation = new Promise((resolve, reject) => { resolveNavigation = resolve; rejectNavigation = reject })
    navigation.catch(() => {}) // 监听期可能早于命令响应，避免未处理拒绝。
    const listeners = []
    const cleanup = () => {
      clearTimeout(timer)
      timers.delete(timer)
      for (const [name, handler] of listeners) contents.off(name, handler)
    }
    const settle = error => {
      if (settled) return
      settled = true
      cleanup()
      if (error) rejectNavigation(error)
      else resolveNavigation()
    }
    const listen = (name, handler) => { listeners.push([name, handler]); contents.on(name, handler) }
    const timer = setTimeout(() => {
      const error = new Error(`navigation timed out after ${timeoutMs}ms; page may still be loading`)
      if (job) cancelRequest(job, error)
      // 页面加载可能还在继续；超时先通知调用者，但队列等到加载真正结束或显式重置。
    }, timeoutMs)
    timers.add(timer)
    listen('did-start-navigation', (details, url, _inPlace, legacyMain) => {
      if ((details.isMainFrame ?? legacyMain) === true) {
        started = true
        stopped = false
        addresses.add(details.url ?? url)
      }
    })
    listen('did-redirect-navigation', (details, url, _inPlace, legacyMain) => {
      if ((details.isMainFrame ?? legacyMain) === true) addresses.add(details.url ?? url)
    })
    listen('did-navigate', (_event, url, status) => {
      if (started && addresses.has(url) && status >= 400) httpError = new Error(`navigation failed: HTTP ${status}`)
    })
    listen('did-finish-load', () => { if (started) settle(httpError) })
    listen('did-stop-loading', () => {
      stopped = true
      if (started && httpError) settle(httpError)
    })
    listen('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (started && isMainFrame && addresses.has(url)) settle()
    })
    const failed = (_event, code, description, url, isMainFrame) => {
      if (!started || !isMainFrame || !addresses.has(url)) return
      httpError = new Error(`navigation failed: ${description} (${code})`)
      // provisional 和最终 fail 可能分两次到达，不能提前放行下一次导航。
      if (stopped) settle(httpError)
    }
    listen('did-fail-load', failed)
    listen('did-fail-provisional-load', failed)
    try {
      const result = await command()
      if (result?.errorText || result?.isDownload) {
        httpError = new Error(result.errorText ? `navigation failed: ${result.errorText}` : 'navigation started a download instead of loading a page')
        if (!started || stopped) settle(httpError)
      }
      await whileLive(() => navigation)
      assertOperation()
      if (httpError) throw httpError // 完成事件可能先于 CDP 的失败/下载响应到达。
      return snapshot()
    } catch (error) {
      if (job?.error && !disposed && started && !settled) {
        await whileLive(() => navigation).catch(() => {})
      }
      throw error
    } finally {
      cleanup()
    }
  }

  async function navigate(url) {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) {
      throw new Error(`unsupported URL protocol: ${parsed.protocol}`)
    }
    return navigateAndWait(() => cdp('Page.navigate', { url }, true), 15_000)
  }

  const CURSOR_ID = '__dsh_browser_use_cursor__'

  // 光标和点击波纹只是页面内的视觉标记，不移动系统指针，也不激活原生窗口。
  // 模板插值发生在主进程；JSON.stringify 把字符串编码成带引号、转义的
  // JavaScript 数据字面量，再嵌入脚本文本。不能把 label/selector 等字符串
  // 直接拼作源码，否则引号、反斜杠或换行会改变脚本含义；它不是 HTML 转义。
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
      // 先移动容器：即使网站阻止了部分装饰，位置仍应对应实际操作点。
      host.style.transform = 'translate3d(${Math.round(x)}px,${Math.round(y)}px,0)'
      try {
        let arrow = host.querySelector('[data-arrow]')
        if (arrow === null) {
          // 用 DOM API 创建节点而不是写 innerHTML。部分网站启用 Trusted Types，
          // 会拒绝给 innerHTML 赋字符串，导致光标容器为空。
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

  async function resolveTarget(ref, mode = 'click') {
    assertOperation()
    if (!Number.isSafeInteger(ref) || !refs.has(ref)) throw new Error(`stale or unknown snapshot ref: ${ref}; take a new snapshot`)
    const version = documentVersion
    const point = await evaluate(`(() => {
      const el = globalThis[${JSON.stringify(elementRegistryKey)}]?.get(${JSON.stringify(ref)})
      if (!el || !el.isConnected || el.ownerDocument !== document) throw new Error('snapshot element was removed; take a new snapshot')
      el.scrollIntoView({ block: 'center', inline: 'center' })
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (rect.width < 4 || rect.height < 4 || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || el.disabled || el.closest('[inert]')) throw new Error('snapshot element is not interactable; take a new snapshot')
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
      const top = document.elementFromPoint(x, y)
      if (!top || (top !== el && !el.contains(top))) throw new Error('snapshot element is covered; take a new snapshot')
      const mode = ${JSON.stringify(mode)}
      if (mode !== 'click') {
        const editable = el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text','search','email','url','tel','password','number'].includes(el.type))
        if (!editable || el.readOnly) throw new Error('snapshot element is not editable')
        if (mode === 'focus') el.focus()
        if (document.activeElement !== el && !(el.isContentEditable && el.contains(document.activeElement))) throw new Error('input focus changed; take a new snapshot')
      }
      return { x, y }
    })()`)
    if (version !== documentVersion || !refs.has(ref)) throw new Error('page changed before input; take a new snapshot')
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('snapshot target is unavailable; take a new snapshot')
    return point
  }

  async function click(ref) {
    let target = await resolveTarget(ref)
    await showCursor(target.x, target.y, 'click')
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    target = await resolveTarget(ref) // hover 可能展开遮挡层，再次验证，不回退旧坐标。
    // 一旦按下已经发送，释放属于同一次点击的收尾，必须成对完成，不能留下鼠标长按。
    // 取消无法撤销已开始的点击；后续涟漪/等待及排队操作会按取消状态停止。
    await whileLive(async () => {
      assertOperation()
      const pointer = { x: target.x, y: target.y, button: 'left', clickCount: 1 }
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { ...pointer, type: 'mousePressed' })
      assertLive()
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { ...pointer, type: 'mouseReleased' })
    })
    assertOperation()
    await showRipple(target.x, target.y)
    await delay(160)
    return { clicked: true, ref, x: Math.round(target.x), y: Math.round(target.y) }
  }

  // focus 仅改变页面内的输入位置，绝不激活原生窗口。每次插入前确认焦点仍在原元素，
  // 避免网站重渲染/用户切焦后把剩余文字写进其他输入框。
  async function type(ref, text) {
    let point = await resolveTarget(ref, 'focus')
    const characters = Array.from(text)
    for (const character of characters) {
      point = await resolveTarget(ref, 'typing')
      await cdp('Input.insertText', { text: character })
      await delay(18)
    }
    await showCursor(point.x, point.y, 'type')
    await delay(50)
    return { typed: characters.length }
  }

  // 从页面绘制表面获取 JPEG，不截取整个桌面；透明、屏幕外窗口仍保留此表面。
  async function screenshot() {
    const response = await cdp('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 80,
      fromSurface: true,
    })
    return { base64: response.data, mime: 'image/jpeg' }
  }

  // 每轮同时检查文档状态和调用方提供的选择器、文本、URL 前缀条件。
  // 超时返回 ready: false 而不是抛错，保留调用方可区分的业务结果。
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
        assertOperation()
        // 导航可能在这轮检查期间替换执行上下文，等待下一轮重试。
      }
      await delay(150)
    }
    return { ready: false, reason: `timeout after ${timeoutMs}ms` }
  }

  // 轻量状态查询不重建 refs；只有 snapshot 会替换元素编号映射。
  async function pageState() {
    return evaluate(`(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyText: document.body ? document.body.innerText.slice(0, 400) : '',
    }))()`)
  }

  async function dispatch(message) {
    assertLive()
    // 用户离开人工查看窗口后，先恢复后台契约，再处理请求。普通页面操作
    // 不主动展示窗口；下面的 windowShow 是明确请求展示的例外。
    if (win !== null && !win.isDestroyed() && win.isVisible() && (WINDOWS_TASKBAR ? !backgrounded : win.getOpacity() > 0) && !appActive()) {
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
        // eval 的页面异常是内层业务结果 ok: false，不改变外层 RPC 成功信封。
        try {
          const value = await evaluate(message.expression)
          return { ok: true, value: typeof value === 'string' ? value : JSON.stringify(value ?? null) }
        } catch (error) {
          assertOperation()
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
          windowId: win.id,
          windowNumber,
          conversationId,
          bounds: win.getBounds(),
          visible: win.isVisible(),
          focused: win.isFocused(),
          minimized: win.isMinimized(),
          opacity: win.getOpacity(),
          title: win.getTitle(),
        }
      case 'back': {
        const history = await cdp('Page.getNavigationHistory')
        if (history.currentIndex <= 0) throw new Error('no previous page in this window history')
        return navigateAndWait(() => cdp('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id }, true), 10_000)
      }
      case 'reload':
        return navigateAndWait(() => cdp('Page.reload', { ignoreCache: false }, true), 10_000)
      case 'close':
        // 只销毁本对话窗口；已排进旧队列的请求不能转交给以后创建的新窗口。
        dispose()
        return { closed: true }
      default:
        throw new Error(`unknown op: ${message.op}`)
    }
  }

  // 不调用 hide()，保留绘制表面。Windows 的背景窗口不透明，必须放到所有
  // 显示器组成的虚拟桌面之外，不能只放主屏左侧（那里可能还有另一块屏幕）。
  function park() {
    if (win === null) return false
    try {
      const bounds = win.getBounds()
      const area = screen.getPrimaryDisplay().workArea
      const displays = WINDOWS_TASKBAR ? screen.getAllDisplays() : []
      const left = WINDOWS_TASKBAR
        ? Math.min(area.x, ...displays.map(display => display.bounds.x))
        : area.x
      win.setPosition(left - bounds.width - 200, area.y + 33)
      if (!WINDOWS_TASKBAR) return true
      const actual = win.getBounds()
      // 某些窗口管理策略会把离屏位置夹回屏内。宁可临时透明、预览空白，
      // 也不能把本应隐藏的网页直接暴露到桌面；下一次成功停放会恢复绘制。
      return displays.length > 0 && displays.every(({ bounds: display }) =>
        actual.x + actual.width <= display.x || actual.x >= display.x + display.width
        || actual.y + actual.height <= display.y || actual.y >= display.y + display.height)
    } catch {
      return false
    }
  }

  // 优先查询整个应用的激活状态；旧版本/不支持的平台退回窗口焦点判断。
  function appActive() {
    try {
      // app.isActive 是 macOS 的应用级概念；Windows 直接判断当前窗口是否获焦。
      if (!WINDOWS_TASKBAR && typeof app.isActive === 'function') return app.isActive()
    } catch {
      // 查询失败时继续使用下方的窗口焦点回退。
    }
    return win !== null && !win.isDestroyed() && win.isFocused()
  }

  // 人工查看入口允许主动激活：恢复交互、透明度和屏内位置，再显示并聚焦。
  // Dock 菜单、Windows 任务栏激活和显式 windowShow 都复用它，普通页面动作不调用。
  function revealWindow() {
    if (!isReady()) return { shown: false, reason: 'no window' }
    backgrounded = false
    transitioning = true
    try {
      record.lastUsed = ++lastUse
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
      // Windows 的 app.focus 会选择应用的第一个窗口，不能覆盖用户点击的编号。
      if (!WINDOWS_TASKBAR) app.focus({ steal: true })
      return { shown: true, bounds: win.getBounds(), opacity: win.getOpacity(), visible: win.isVisible() }
    } finally {
      transitioning = false
    }
  }

  // Windows 的 focusable:false 会使窗口退出任务栏，因此必须保留可激活能力。
  // 可激活不等于主动激活：工具只用 showInactive；用户点任务栏后才会移回屏内。
  // 其他平台沿用透明、不可聚焦的原逻辑。
  function setBackgroundProperties({ updateTaskbar = true } = {}) {
    if (updateTaskbar) win.setSkipTaskbar(!WINDOWS_TASKBAR)
    win.setFocusable(WINDOWS_TASKBAR)
    try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  }

  function showInactiveInBackground() {
    if (WINDOWS_TASKBAR) {
      // 先移出整个桌面，再保持不透明表面，避免透明度 0 导致任务栏预览空白。
      win.setOpacity(park() ? 1 : 0)
      win.showInactive()
    } else {
      win.setOpacity(0)
      win.showInactive()
      park()
    }
  }

  // hidden 指“退回后台”，不是原生 hidden：Windows 仍留在任务栏供悬停预览，
  // 但窗口在所有屏幕之外、点击穿透、不会由工具主动激活。
  function hideToBackground() {
    if (!isReady()) return { hidden: false, reason: 'no window' }
    backgrounded = true
    transitioning = true
    try {
      // 可激活窗口不会因 showInactive 自动失焦；主动收回已显示窗口时先释放键盘焦点。
      if (WINDOWS_TASKBAR && win.isFocused()) win.blur()
      setBackgroundProperties()
      showInactiveInBackground()
      return { hidden: true, bounds: win.getBounds(), opacity: win.getOpacity(), visible: win.isVisible() }
    } finally {
      transitioning = false
    }
  }

  async function initialize() {
    assertLive()
    sessionUsed = true
    // 页面渲染进程与主进程隔离，不启用网页的 Node.js 集成；后台不节流，
    // 让页面任务在不激活窗口时继续运行。show: false 仅控制初始创建状态。
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      title,
      skipTaskbar: !WINDOWS_TASKBAR,
      webPreferences: {
        session: session.defaultSession,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    })
    // 页面不能再开第二个原生窗口。target=_blank 等 HTTP(S) 链接改在当前
    // 窗口加载，其他新窗口请求拒绝；不影响其他对话已拥有的窗口。
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (!disposed && /^https?:/i.test(url)) {
        win.loadURL(url).catch(() => {})
      }
      return { action: 'deny' }
    })
    // 点击链接、脚本跳转、前进后退和 SPA 路由都必须作废旧 ref；仅主框架影响本窗口。
    win.webContents.on('did-start-navigation', (details, _url, _inPlace, legacyMain) => {
      if ((details.isMainFrame ?? legacyMain) === true) invalidateRefs()
    })
    win.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) invalidateRefs()
    })
    win.webContents.on('did-create-window', child => {
      try { child.destroy() } catch {}
    })
    // 网页标题不能覆盖人工识别用的窗口编号；网页自己的 title 仍由 state 返回。
    win.on('page-title-updated', event => { event.preventDefault() })
    win.on('focus', () => {
      if (!isReady()) return
      record.lastUsed = ++lastUse
      // 点击 Windows 任务栏缩略图会激活对应原生窗口；此时恢复到可见工作区。
      // revealWindow 自己也会 focus，所以先改状态并用 transitioning 防止递归。
      if (WINDOWS_TASKBAR && backgrounded && !transitioning) revealWindow()
    })
    win.on('closed', () => dispose())
    win.webContents.on('destroyed', () => dispose())
    win.webContents.on('render-process-gone', (_event, details) => {
      dispose(new Error(`renderer gone: ${details.reason}`))
    })
    // macOS/Linux 的原生关闭仍只退出人工查看；宿主退出时放行关闭。
    // Windows 的 X/Alt+F4 则明确丢弃本代窗口，立即拒绝其执行中与排队请求。
    // 先阻止默认 close，再由 dispose 直接 destroy，故不会被网页 beforeunload
    // 挂起或弹出确认框；未提交的表单/页面内存状态会丢失，共享 Cookie 不清除。
    win.on('close', event => {
      if (quitting || disposed || nativeCloseRequested) return
      event.preventDefault()
      if (!WINDOWS_TASKBAR) {
        hideToBackground()
        return
      }
      // 只接受当前登记记录的原生关闭；旧代迟到的事件不能影响重建的窗口。
      if (windows.get(conversationId) !== record) return
      nativeCloseRequested = true
      dispose(new Error('conversation window closed'))
      // 仅用户关闭最后一扇原生窗口才退出；不在 window-all-closed 中推断意图。
      // 此路径不经过 await，quitHost 同步设置 quitting，刷新共享存储期间
      // 新 RPC 因而会被拒绝，不能一边退出一边偷偷创建新窗口。
      if (windows.size === 0) quitHost()
    })
    win.on('minimize', () => {
      // 最小化会影响绘制表面，稍后非激活地退回后台；Windows 不调用 restore。
      // 其他平台保持 restore → 交互属性 → opacity → showInactive → park 的顺序，
      // 不借用 hideToBackground，以免额外修改任务栏属性。
      schedule(() => {
        if (win === null || win.isDestroyed()) return
        backgrounded = true
        transitioning = true
        try {
          // Windows 的 restore 可能激活窗口；优先使用非激活显示来退出最小化。
          if (WINDOWS_TASKBAR) {
            setBackgroundProperties()
            showInactiveInBackground()
          } else {
            win.restore()
            setBackgroundProperties({ updateTaskbar: false })
            showInactiveInBackground()
          }
        } finally {
          transitioning = false
        }
      }, 50)
    })
    win.on('blur', () => {
      // 切到其他应用或 DSH 对话后回到屏幕外。短暂延后让焦点切换稳定下来；
      // 页内点击不会让原生窗口失焦，因此仍可留在窗口中观察自动化过程。
      schedule(() => {
        if (win === null || win.isDestroyed()) return
        if (appActive() && win.isFocused()) return
        hideToBackground()
      }, 120)
    })
    // 先建立初始文档，再附加唯一的 CDP 会话；后续导航复用同一个 debugger。
    await whileLive(() => win.loadURL('about:blank'))
    assertLive()
    win.webContents.debugger.attach('1.3')
    await cdp('Page.enable')
    assertLive()
    setBackgroundProperties()
    try {
      win.setMinimizable(false)
    } catch {
      // 部分平台不支持禁用最小化，失败不阻断启动。
    }
    // Windows 先离屏再显示不透明表面，避免初始闪现；其他平台保留原顺序。
    // 其他平台启动仍是 showInactive → opacity → park，与隐藏/恢复的顺序不同。
    if (WINDOWS_TASKBAR) showInactiveInBackground()
    else {
      win.showInactive()
      win.setOpacity(0)
      park()
    }
    revealReady = true
    // 有些焦点变化不触发 blur（例如从未成为焦点窗口的 showInactive 窗口），
    // 定时检查作为补偿，确保人工展示状态不会在切出应用后一直残留。
    watch = setInterval(() => {
      if (win === null || win.isDestroyed()) return
      if (win.isVisible() && (WINDOWS_TASKBAR ? !backgrounded : win.getOpacity() > 0) && !appActive()) hideToBackground()
    }, 700)
    // 不让这项检查单独维持进程存活；可选调用兼容不提供 unref 的环境。
    watch.unref?.()
    updateDockMenu()
  }

  // 先登记再异步初始化；同一轮到达的首批请求共享一个 ready 和一个队列。
  windows.set(conversationId, record)
  updateDockMenu()
  record.ready = Promise.resolve().then(initialize).catch(error => {
    dispose(error)
    throw error
  })
  // 首请求可能在初始化完成前就被取消/重置；仍必须消费 ready 的拒绝，避免进程告警。
  // 原 Promise 保留失败状态，尚在等待它的有效请求仍会得到同一错误。
  record.ready.catch(() => {})
  return record
}

// 单行 JSON 是一个 RPC 请求：先 hello 认证，再把 op 交给 dispatch。
// id 原样回传以匹配请求；解析失败的行按现有协议忽略。
function onLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return
  if (authenticated !== true) {
    if (message.op !== 'hello' || message.token !== TOKEN) {
      socket.destroy()
      return
    }
    authenticated = true
    send({ id: message.id, ok: true, result: { pid: process.pid } })
    return
  }
  const fail = error => send({ id: message.id, ok: false, error: String(error && error.message ? error.message : error) })
  // 路由只认外层 conversationId；先校验再分配窗口，错误请求没有创建副作用。
  if (typeof message.conversationId !== 'string' || message.conversationId.trim() === '') {
    fail(new Error('conversationId must be a nonblank string'))
    return
  }
  if (message.op === 'cancel') {
    const job = requests.get(message.requestId)
    if (job && job.message.conversationId === message.conversationId) {
      cancelRequest(job, new Error('browser operation cancelled; completed page effects cannot be undone'))
    }
    return // 取消通知没有独立响应，不创建窗口，也不回收任何对话。
  }
  if ((typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) || requests.has(message.id)) {
    fail(new Error('request id must be unique and a string or safe integer'))
    return
  }
  if (!operations.has(message.op)) {
    const name = typeof message.op === 'string' ? message.op : JSON.stringify(message.op)
    fail(new Error(`unknown op: ${name}`))
    return
  }
  if (quitting) {
    fail(new Error('host shutting down'))
    return
  }
  let record = windows.get(message.conversationId)
  if (message.op === 'close' || message.op === 'reset') {
    // 控制面不进页面队列，否则永远等不到卡住的 eval/wait 结束。
    // 仅用户显式调用才丢弃窗口现场；Cookie 等共享存储不清理。
    record?.dispose(new Error(`conversation window ${message.op === 'reset' ? 'reset' : 'closed'}`))
    send({ id: message.id, ok: true, result: message.op === 'reset' ? { reset: true } : { closed: true } })
    return
  }
  if (record === undefined) record = createConversation(message.conversationId)
  const job = { message, record, error: null, done: false, timer: null, cancelWaiters: new Set() }
  requests.set(message.id, job)
  record.jobs.add(job)
  job.timer = setTimeout(() => cancelRequest(job, new Error('browser request deadline exceeded; reset explicitly if the window remains blocked')), REQUEST_TIMEOUT_MS)
  record.queue = record.queue.then(async () => {
    if (job.done) return
    try {
      await record.ready
      if (job.done) return
      record.assertLive()
      record.lastUsed = ++lastUse
      const result = await record.execute(job)
      record.assertLive()
      finishRequest(job, null, result)
    } catch (error) {
      finishRequest(job, error)
    }
  })
}

// 只保留第一个连接，额外连接立即关闭；认证和缓冲区由宿主持有，
// 不需要给多个客户端各建一套。一次 data 事件不等于一条完整 JSON 消息。
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
    // 父进程断开控制连接即结束宿主，避免留下无人管理的后台进程。
    if (socket === connection) socket = null
    quitHost()
  })
}

async function start() {
  if (HIDE_DOCK) app.dock?.hide()
  updateDockMenu()
  if (WINDOWS_TASKBAR) {
    const repark = () => { for (const record of windows.values()) record.onDisplaysChanged() }
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, repark)
  }
  // 只监听本机回环地址，端口 0 让系统选择可用端口。stdout 的单行 JSON
  // 专供父进程发现端口；启动/服务错误写 stderr，避免污染协议输出。
  server = createServer(onConnection)
  server.on('error', error => {
    console.error(`[dsh-browser-use] rpc server error: ${error.message}`)
    quitHost()
  })
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    process.stdout.write(`${JSON.stringify({ port: address.port })}\n`)
  })
}

// 信号、控制连接断开、Cmd+Q 和 Windows 用户关闭最后原生窗口才结束宿主；
// RPC close/reset 只处置对应对话，不改变共享宿主的惰性重建语义。
process.on('SIGTERM', quitHost)
process.on('SIGINT', quitHost)

// 就绪后只创建服务；第一条合法对话操作才创建共享默认 Session 的后台窗口。
app.whenReady().then(start).catch(error => {
  console.error(`[dsh-browser-use] host failed: ${error && error.stack ? error.stack : error}`)
  quitHost()
})
app.on('activate', () => {
  const record = Array.from(windows.values()).filter(item => item.isReady())
    .sort((left, right) => right.lastUsed - left.lastUsed)[0]
  record?.revealWindow()
})
app.on('did-resign-active', () => {
  for (const record of windows.values()) record.onResign()
})
app.on('before-quit', () => {
  quitting = true
  for (const record of windows.values()) record.dispose(new Error('host shutting down'))
})
app.on('window-all-closed', () => {
  // 程序销毁、reset 和初始化失败同样到达这里，不能据此推断用户要退出。
  // 保留 TCP 服务以便惰性重建；Windows 最后一次原生关闭由本代 close 处理。
})
