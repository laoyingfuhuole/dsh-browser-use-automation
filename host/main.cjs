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

const { app, BrowserWindow, WebContentsView, Menu, screen, session, ipcMain } = require('electron')
const { createServer } = require('node:net')
const { randomBytes, createHmac, timingSafeEqual } = require('node:crypto')
const { mkdirSync, mkdtempSync, statSync, rmSync } = require('node:fs')
const { isAbsolute, join, basename, resolve, win32 } = require('node:path')
const { installNativeIPC, installNativeSession, createNativeUI } = require('./native-ui.cjs')
const { downloadLimits, remainingDiskBudget } = require('./download-quota.cjs')
const componentDefinitions = require('../src/components.json')
let enabledComponents = new Set(process.env.BROWSER_USE_COMPONENTS === undefined
  ? Object.keys(componentDefinitions) : JSON.parse(process.env.BROWSER_USE_COMPONENTS))

function componentEnabled(name) { return enabledComponents.has(name) }

function configureComponents(enabled) {
  if (!Array.isArray(enabled) || enabled.some(name => !Object.hasOwn(componentDefinitions, name))) {
    throw new TypeError('invalid browser component configuration')
  }
  const removed = [...enabledComponents].filter(name => !enabled.includes(name))
  enabledComponents = new Set(enabled)
  for (const conversation of windows.values()) {
    for (const record of [conversation, ...conversation.tabs.values()]) {
      for (const job of record.jobs) {
        if (removed.includes(job.message.component)) cancelRequest(job, new Error(`browser component disabled: ${job.message.component}`))
        else if (removed.includes('requests') && job.message.op === 'upload') cancelRequest(job, new Error('webpage request-handling component disabled during upload'))
      }
    }
    for (const tab of conversation.tabs.values()) tab.updateComponents()
  }
  if (!componentEnabled('files')) for (const download of activeDownloads.values()) {
    download.entry.error = 'download cancelled because file component was disabled'
    download.item.cancel()
  }
}

// 仅显式指定时改存储位置，且必须早于 ready；平时沿用现有默认资料和登录态。
// BROWSER_USE_* 是既有配置协议；包改名不改环境变量和默认用户资料目录，保留登录。
const userDataDir = process.env.BROWSER_USE_USER_DATA_DIR
if (userDataDir !== undefined) {
  if (!isAbsolute(userDataDir)) throw new Error('BROWSER_USE_USER_DATA_DIR must be an absolute path')
  mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
  app.setPath('sessionData', userDataDir)
}

// 父进程通过环境变量配置本次宿主；KEEP_DOCK 显式覆盖 HIDE_DOCK。
const TOKEN = Buffer.from(process.env.BROWSER_USE_TOKEN || '')
if (TOKEN.length === 0) throw new Error('BROWSER_USE_TOKEN is required')
const SESSION_MODE = process.env.BROWSER_USE_SESSION_MODE ?? 'shared'
if (!['shared', 'isolated'].includes(SESSION_MODE)) throw new Error('BROWSER_USE_SESSION_MODE must be shared or isolated')
const WIDTH = Number(process.env.BROWSER_USE_WIDTH || 1400) || 1400
const HEIGHT = Math.max(160, Number(process.env.BROWSER_USE_HEIGHT) || 900)
const FORCE_DOCK = process.env.BROWSER_USE_KEEP_DOCK === '1'
const HIDE_DOCK = process.env.BROWSER_USE_HIDE_DOCK === '1' && FORCE_DOCK !== true
const WINDOWS_TASKBAR = process.platform === 'win32'
// Windows 用同一个应用标识将本 host 的所有窗口归组；不创建系统托盘图标。
// 必须在创建任何窗口之前设置，且不修改 app 名称/数据目录，避免影响已有登录。
if (WINDOWS_TASKBAR) app.setAppUserModelId('laoyingfuhuole.dsh-browser-use-automation')

// 宿主只保留一个控制连接；窗口、refs、CDP、就绪状态与队列均按对话隔离。
let server = null
let socket = null
const handshakes = new Set()
const HANDSHAKE_TIMEOUT_MS = 2_000
const HANDSHAKE_BUFFER_LIMIT = 1024
const HANDSHAKE_CONNECTION_LIMIT = 16
const RPC_BUFFER_LIMIT = 8 * 1024 * 1024
let quitting = false
let sessionUsed = false
let nextWindowNumber = 0
let nextElementRef = 0 // host 内单调递增，快照更新及窗口重建都不复用旧编号。
let lastUse = 0
const windows = new Map()
const toolbars = new Map()
// 一个连接内的请求表：取消通过 requestId 定位，同时校验 conversationId，不能跨对话。
const requests = new Map()
const REQUEST_TIMEOUT_MS = 60_000
const EVAL_RESULT_MAX_CHARS = 1_000_000
const READ_MAX_CHARS = 24_000
const downloadRecords = new Map()
const downloadOwners = new Map()
const activeDownloads = new Map()
const nativeControllers = new Map()
const DOWNLOAD_HISTORY_LIMIT = 50
const quotas = downloadLimits(process.env)
let downloadDirectory

function downloadSpace() {
  return remainingDiskBudget(downloadDirectory, quotas.directoryBytes, activeDownloads.values())
}

function trimDownloads(history) {
  while (history.length > DOWNLOAD_HISTORY_LIMIT) {
    const index = history.findIndex(entry => !activeDownloads.has(entry.id))
    if (index < 0) break
    history.splice(index, 1)
  }
}

function handleDownload(event, item, contents) {
  const owner = downloadOwners.get(contents)
  if (!owner || quitting || !componentEnabled('files')) {
    event.preventDefault()
    console.error('[dsh-browser-use-automation] download rejected: file component disabled or no live conversation owner')
    return
  }
  const history = downloadRecords.get(owner.conversationId)
  const entry = {
    id: randomBytes(16).toString('hex'), filename: '', state: 'progressing',
    receivedBytes: 0, totalBytes: 0,
  }
  history.push(entry)
  let directory
  let budget
  try {
    // 每次分配独占目录，既保留原文件名，又避免跨对话/同名并发下载覆盖已有文件。
    const suggested = basename(win32.basename(item.getFilename()))
    const characters = Array.from(suggested.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, ''))
    while (Buffer.byteLength(characters.join(''), 'utf8') > 180) characters.pop()
    entry.filename = characters.join('') || 'download'
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(entry.filename)) entry.filename = '_' + entry.filename
    if (activeDownloads.size >= quotas.concurrent) throw new Error('concurrent download limit reached')
    entry.totalBytes = item.getTotalBytes()
    const space = downloadSpace()
    const max = Math.min(quotas.fileBytes, space)
    if (entry.totalBytes > quotas.fileBytes) throw new Error('download exceeds single-file limit')
    if (max <= 0 || entry.totalBytes > max) throw new Error('download directory budget exhausted')
    budget = entry.totalBytes > 0 ? entry.totalBytes : max
    mkdirSync(downloadDirectory, { recursive: true })
    directory = mkdtempSync(join(downloadDirectory, 'download-'))
    entry.path = join(directory, entry.filename)
    item.setSavePath(entry.path)
  } catch (error) {
    event.preventDefault()
    if (directory) {
      try { rmSync(directory, { recursive: true, force: true }) } catch {}
      delete entry.path
    }
    entry.state = 'failed'
    entry.error = `could not prepare download: ${error.message}`
    console.error(`[dsh-browser-use-automation] ${entry.error}`)
    trimDownloads(history)
    return
  }
  const exceedsBudget = () => entry.receivedBytes > budget || entry.totalBytes > budget
  let overQuota = false
  const update = (_event, state) => {
    entry.state = state
    entry.receivedBytes = item.getReceivedBytes()
    entry.totalBytes = item.getTotalBytes()
    if (!overQuota && exceedsBudget()) {
      overQuota = true
      item.cancel()
    }
  }
  const done = (_event, state) => {
    item.off('updated', update)
    activeDownloads.delete(entry.id)
    entry.state = state
    entry.receivedBytes = item.getReceivedBytes()
    entry.totalBytes = item.getTotalBytes()
    if (state === 'completed') {
      try {
        const file = statSync(entry.path)
        if (!file.isFile()) throw new Error('saved download is not a file')
        entry.receivedBytes = file.size
      } catch (error) {
        entry.state = 'failed'
        entry.error = `download completed but saved file is unavailable: ${error.message}`
      }
    }
    if (overQuota || exceedsBudget()) {
      entry.state = 'failed'
      entry.error = 'download exceeded its reserved byte budget'
      try { rmSync(directory, { recursive: true, force: true }); delete entry.path } catch (error) {
        entry.error += `; could not remove over-quota output: ${error.message}`
      }
    } else if (entry.state !== 'completed' && !entry.error) entry.error = `download ${state}`
    if (entry.state !== 'completed') console.error(`[dsh-browser-use-automation] ${entry.error}`)
    trimDownloads(history)
  }
  activeDownloads.set(entry.id, { item, owner, entry, directory, budget })
  item.on('updated', update)
  item.once('done', done)
  trimDownloads(history)
}

function finishRequest(job, error, result) {
  if (job.done) return
  job.done = true
  clearTimeout(job.timer)
  requests.delete(job.message.id)
  job.record.jobs.delete(job)
  if (error) {
    const progress = job.inputProgress
    const detail = progress
      ? `; input progress: ${progress.typed}/${progress.total} Unicode code points acknowledged${progress.inFlight ? ', an in-flight chunk may still complete' : ''}; inspect the field before continuing, do not retry automatically`
      : ''
    send({ id: job.message.id, ok: false, error: (error.message || String(error)) + detail })
  }
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

function createRequestJob(message, record) {
  const job = { message, record, error: null, done: false, timer: null, cancelWaiters: new Set() }
  requests.set(message.id, job)
  record.jobs.add(job)
  job.timer = setTimeout(() => cancelRequest(job, new Error('browser request deadline exceeded; inspect state before retrying')), REQUEST_TIMEOUT_MS)
  return job
}
const operations = new Set([
  'navigate', 'snapshot', 'click', 'hover', 'type', 'insertText', 'scroll', 'key', 'screenshot', 'eval',
  'wait', 'state', 'read', 'downloads', 'requests', 'respond', 'upload', 'pdf',
  'tabs', 'windowShow', 'windowHide', 'windowState', 'back', 'reload', 'close', 'reset',
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
  for (const connection of handshakes) connection.destroy()
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
    console.error(`[dsh-browser-use-automation] session flush failed: ${error.message}`)
  }).finally(() => app.quit())
}

function send(message) {
  if (socket === null || socket.destroyed) return
  // 换行是协议帧边界；JSON.stringify 会把字符串内的换行编码进 JSON。
  socket.write(`${JSON.stringify(message)}\n`)
}

// 闭包把所有 await 前后的页面操作固定在同一个窗口；没有全局“当前窗口”。
function createTab(conversationId, view, adopted, remove) {
  const contents = view.webContents
  let refs = new Map()
  let documentVersion = 0
  let nativeUI = null
  const elementRegistryKey = '__dsh_refs_' + randomBytes(16).toString('hex')
  // 每个标签独立签发游标，跨对话、close/reset 和 host 重启都不能误用旧读取位置。
  const readCursorKey = randomBytes(32)
  function invalidateRefs() { refs.clear(); documentVersion += 1; nativeUI?.invalidate() }
  let disposed = false
  let failure
  let activeJob
  const timers = new Set()
  const pending = new Set()
  const record = {
    id: randomBytes(16).toString('hex'), conversationId, view, contents, queue: Promise.resolve(),
    dispose, assertLive, manualNavigation, ready: null,
    status: () => nativeUI.status(),
    jobs: new Set(),
    async execute(job) {
      activeJob = job
      try {
        assertOperation()
        nativeUI.assertUnblocked()
        return await dispatch(job.message)
      } finally { activeJob = null }
    },
    nativeRequest(message, job) {
      const guard = () => {
        assertLive()
        if (job.error) throw job.error
      }
      guard()
      if (message.op === 'respond') return nativeUI.resolve(message.requestId, message.accept, message.value)
      if (message.op === 'upload') return nativeUI.upload(message.requestId, message.paths, guard)
      throw new Error('unsupported native request')
    },
    assertPageAvailable() { nativeUI?.assertUnblocked() },
    updateComponents() { nativeUI?.setEnabled({ files: componentEnabled('files'), requests: componentEnabled('requests') }) },
  }

  function assertLive() {
    if (disposed) throw failure
    if (contents.isDestroyed()) throw new Error('browser tab closed')
  }

  function assertOperation() {
    assertLive()
    if (activeJob?.error) throw activeJob.error
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

  function dispose(error = new Error('browser tab closed')) {
    if (disposed) return
    disposed = true
    failure = error
    nativeUI?.invalidate()
    downloadOwners.delete(contents)
    nativeControllers.delete(contents)
    for (const download of activeDownloads.values()) {
      if (download.owner === record) {
        download.entry.error = 'download cancelled because its browser tab closed'
        download.item.cancel()
      }
    }
    for (const job of record.jobs) cancelRequest(job, error)
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    refs.clear()
    for (const reject of pending) reject(error)
    pending.clear()
    remove(record, error)
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false })
  }

  // CDP（Chrome DevTools Protocol）经 Electron 的 debugger 接口控制当前页面，
  // 不依赖系统鼠标、键盘或把原生窗口切到前台。
  async function cdp(method, params = {}, navigationCommand = false) {
    assertOperation()
    const response = await whileLive(() => {
      assertOperation()
      return contents.debugger.sendCommand(method, params)
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
    const options = SNAPSHOT_OPTIONS
    const selectors = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[contenteditable="true"]'
    const root = options.selector ? document.querySelector(options.selector) : document
    if (!root) throw new Error('snapshot selector did not match an element')
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 4 || rect.height < 4) return false
      const style = getComputedStyle(el)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }
    const labelOf = (el) => String(
      el.getAttribute('aria-label')
      || el.getAttribute('placeholder')
      || (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : el.innerText)
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
    const candidates = root === document || !root.matches(selectors)
      ? root.querySelectorAll(selectors)
      : [root, ...root.querySelectorAll(selectors)]
    let truncated = false
    for (const el of candidates) {
      if (seen.has(el) || !visible(el)) continue
      seen.add(el)
      if (out.length >= options.maxElements) { truncated = true; break }
      const rect = el.getBoundingClientRect()
      const ref = FIRST_REF + out.length
      nodes.set(ref, el)
      out.push({
        ref,
        kind: el.getAttribute('role') || el.tagName.toLowerCase(),
        label: labelOf(el),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        ...options.includeSelectors ? { selector: selectorOf(el) } : {},
      })
    }
    return {
      url: location.href,
      title: document.title,
      elements: out,
      truncated,
      maxElements: options.maxElements,
      ...options.selector ? { selector: options.selector } : {},
    }
  })()`

  // 数字 ref 只属于这个标签的最近快照；任何新快照、主框架导航都会使旧 ref 失效。
  async function snapshot(options = {}) {
    const { selector, maxElements = 150, includeSelectors = true } = options
    if (selector !== undefined && (typeof selector !== 'string' || selector.trim() === '')) {
      throw new TypeError('snapshot selector must be a non-empty CSS selector when provided')
    }
    if (!Number.isInteger(maxElements) || maxElements < 1 || maxElements > 150) {
      throw new TypeError('snapshot maxElements must be an integer between 1 and 150')
    }
    if (typeof includeSelectors !== 'boolean') throw new TypeError('snapshot includeSelectors must be a boolean')
    refs.clear()
    const version = documentVersion
    const firstRef = nextElementRef + 1
    nextElementRef += 150
    if (!Number.isSafeInteger(nextElementRef)) throw new Error('snapshot ref space exhausted; restart host')
    const script = SNAPSHOT_SCRIPT.replace('REGISTRY_KEY', JSON.stringify(elementRegistryKey))
      .replace('FIRST_REF', String(firstRef))
      .replace('SNAPSHOT_OPTIONS', () => JSON.stringify({ selector, maxElements, includeSelectors }))
    const value = await evaluate(script)
    assertOperation()
    if (version !== documentVersion) throw new Error('page changed during snapshot; take a new snapshot')
    for (const element of value.elements) refs.set(element.ref, true)
    return { ...value, tabId: record.id }
  }

  // 先监听主框架加载再发导航命令，不能把旧页面的 readyState=complete 当成新页面成功。
  // Promise 提前失败时先记录结果；仍等正在发送的 CDP 返回，避免旧命令与下一项交错。
  async function navigateAndWait(command, timeoutMs, takeSnapshot = true, reportTimeout) {
    assertOperation()
    invalidateRefs()
    const job = activeJob
    let started = false
    let settled = false
    let timedOut = false
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
      timedOut = true
      const error = new Error(`navigation timed out after ${timeoutMs}ms; page may still be loading`)
      if (job) cancelRequest(job, error)
      else reportTimeout(error)
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
      if (takeSnapshot) return snapshot()
    } catch (error) {
      if ((timedOut || job?.error) && !disposed && started && !settled) {
        await whileLive(() => navigation).catch(() => {})
      }
      throw error
    } finally {
      cleanup()
    }
  }

  function manualNavigation(action, value) {
    // Toolbar and RPC navigations on one tab share the same ordering barrier.
    const response = Promise.withResolvers()
    const next = record.queue.then(async () => {
      await record.ready
      assertLive()
      nativeUI.assertUnblocked()
      if (action === 'navigate') {
        const url = addressURL(value)
        return navigateAndWait(() => cdp('Page.navigate', { url }, true), 15_000, false, response.reject)
      }
      if (action === 'reload') return navigateAndWait(() => cdp('Page.reload', {}, true), 10_000, false, response.reject)
      if (action !== 'back' && action !== 'forward') throw new Error('unknown toolbar action')
      return traverseHistory(action, false, response.reject)
    })
    record.queue = next.catch(() => {})
    next.then(response.resolve, response.reject)
    return response.promise
  }

  async function traverseHistory(direction, takeSnapshot, reportTimeout) {
    const history = await cdp('Page.getNavigationHistory')
    const entry = history.entries[history.currentIndex + (direction === 'back' ? -1 : 1)]
    if (!entry) throw new Error(`no ${direction === 'back' ? 'previous' : 'next'} page in this tab history`)
    return navigateAndWait(() => cdp('Page.navigateToHistoryEntry', { entryId: entry.id }, true), 10_000, takeSnapshot, reportTimeout)
  }

  async function navigate(url) {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'data:'].includes(parsed.protocol)) {
      throw new Error(`unsupported URL protocol: ${parsed.protocol}`)
    }
    return navigateAndWait(() => cdp('Page.navigate', { url }, true), 15_000)
  }

  const CURSOR_ID = '__dsh_browser_use_automation_cursor__'

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

  async function hover(ref) {
    let target = await resolveTarget(ref)
    await showCursor(target.x, target.y, 'hover')
    target = await resolveTarget(ref)
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
    return { dispatched: true, ref, x: target.x, y: target.y }
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
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { ...pointer, type: 'mousePressed' })
      assertLive()
      await contents.debugger.sendCommand('Input.dispatchMouseEvent', { ...pointer, type: 'mouseReleased' })
    })
    assertOperation()
    await showRipple(target.x, target.y)
    await delay(160)
    return { clicked: true, ref, x: Math.round(target.x), y: Math.round(target.y) }
  }

  async function scroll(message) {
    const deltaX = message.deltaX === undefined ? 0 : message.deltaX
    const deltaY = message.deltaY === undefined ? 600 : message.deltaY
    if (!Number.isInteger(deltaX) || Math.abs(deltaX) > 10_000
      || !Number.isInteger(deltaY) || Math.abs(deltaY) > 10_000
      || (deltaX === 0 && deltaY === 0)) {
      throw new TypeError('scroll deltaX/deltaY must be integers within +/-10000 and cannot both be zero')
    }
    const metrics = await cdp('Page.getLayoutMetrics')
    const width = metrics.cssVisualViewport?.clientWidth
    const height = metrics.cssVisualViewport?.clientHeight
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error('scroll could not determine the page CSS viewport dimensions')
    }
    const x = message.x === undefined ? Math.floor(width / 2) : message.x
    const y = message.y === undefined ? Math.floor(height / 2) : message.y
    if (!Number.isInteger(x) || x < 0 || x >= width || !Number.isInteger(y) || y < 0 || y >= height) {
      throw new TypeError(`scroll x/y must be integer CSS viewport coordinates (0 <= x < ${width}, 0 <= y < ${height})`)
    }
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY,
    })
    return { dispatched: true, x, y, deltaX, deltaY }
  }

  const KEY_DEFINITIONS = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
      const number = index + 1
      return [`F${number}`, { key: `F${number}`, code: `F${number}`, keyCode: 111 + number }]
    })),
  }
  const MODIFIER_DEFINITIONS = {
    Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, bit: 2 },
    Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, bit: 1 },
    Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, bit: 8 },
    Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, bit: 4 },
  }

  function parseKeyChord(input) {
    if (typeof input !== 'string' || input.trim() === '') throw new TypeError('key must be a non-empty supported key name or chord')
    const parts = input.split('+').map(part => part.trim())
    if (parts.some(part => part === '')) throw new TypeError('key chord contains an empty component')
    const modifiers = []
    for (const part of parts.slice(0, -1)) {
      let name = part
      if (name === 'Ctrl') name = 'Control'
      if (name === 'Cmd' || name === 'Command') name = 'Meta'
      if (name === 'Mod') name = process.platform === 'darwin' ? 'Meta' : 'Control'
      const definition = MODIFIER_DEFINITIONS[name]
      if (!definition || modifiers.some(modifier => modifier.name === name)) {
        throw new TypeError(`unsupported or repeated key modifier: ${part}`)
      }
      modifiers.push({ name, ...definition })
    }
    const key = parts.at(-1)
    if (MODIFIER_DEFINITIONS[key] || ['Ctrl', 'Cmd', 'Command', 'Mod'].includes(key)) {
      throw new TypeError('key chord must end with a non-modifier key')
    }
    const definition = KEY_DEFINITIONS[key]
    if (!definition) throw new TypeError(`unsupported key: ${key}`)
    return { modifiers, key: definition }
  }

  async function pressKeyChord(input) {
    const { modifiers, key } = parseKeyChord(input)
    let modifierMask = 0
    const release = []
    let operationError
    try {
      for (const modifier of modifiers) {
        assertOperation()
        modifierMask |= modifier.bit
        const params = {
          type: 'keyDown', key: modifier.key, code: modifier.code,
          windowsVirtualKeyCode: modifier.keyCode, nativeVirtualKeyCode: modifier.keyCode,
          modifiers: modifierMask,
        }
        const keyUp = { ...params, type: 'keyUp' }
        await whileLive(() => {
          assertOperation()
          release.unshift({ params: keyUp, modifierBit: modifier.bit })
          const command = contents.debugger.sendCommand('Input.dispatchKeyEvent', params)
          return command
        })
        assertOperation()
      }
      assertOperation()
      const params = {
        type: 'keyDown', key: key.key, code: key.code,
        windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode,
        modifiers: modifierMask,
      }
      await whileLive(() => {
        assertOperation()
        release.unshift({ params: { ...params, type: 'keyUp', modifiers: modifierMask }, modifierBit: 0 })
        const producesText = key.text && (modifierMask === 0 || modifierMask === MODIFIER_DEFINITIONS.Shift.bit)
        return contents.debugger.sendCommand('Input.dispatchKeyEvent',
          producesText ? { ...params, text: key.text } : params)
      })
      assertOperation()
    } catch (error) {
      operationError = error
    }
    const releaseErrors = []
    let releaseMask = modifierMask
    for (const item of release) {
      if (item.modifierBit) releaseMask &= ~item.modifierBit
      try {
        await whileLive(() => contents.debugger.sendCommand('Input.dispatchKeyEvent', {
          ...item.params, modifiers: releaseMask,
        }))
      } catch (error) {
        releaseErrors.push(error)
      }
    }
    if (operationError && releaseErrors.length > 0) {
      throw new Error(`${operationError.message}; additionally failed to release ${releaseErrors.length} key(s)`, { cause: operationError })
    }
    if (operationError) throw operationError
    if (releaseErrors.length > 0) throw new Error(`failed to release ${releaseErrors.length} key(s): ${releaseErrors[0].message}`)
    return { pressed: input, key: key.key, modifiers: modifiers.map(modifier => modifier.name) }
  }

  // focus 仅改变页面内的输入位置，绝不激活原生窗口。每次插入前确认焦点仍在原元素，
  // 避免网站重渲染/用户切焦后把剩余文字写进其他输入框。
  async function type(ref, text, mode = 'human') {
    if (!['human', 'fast'].includes(mode)) throw new TypeError('type mode must be human or fast')
    let point = await resolveTarget(ref, 'focus')
    const characters = Array.from(text)
    if (mode === 'fast') {
      const progress = { typed: 0, total: characters.length, inFlight: false }
      const job = activeJob
      if (job) job.inputProgress = progress
      // 小块保留取消和焦点重检边界；只统计已获 CDP 确认的部分，不猜测超时块的结果。
      for (let start = 0; start < characters.length; start += 256) {
        point = await resolveTarget(ref, 'typing')
        const chunk = characters.slice(start, start + 256)
        await whileLive(async () => {
          assertOperation()
          progress.inFlight = true
          await contents.debugger.sendCommand('Input.insertText', { text: chunk.join('') })
          progress.typed += chunk.length
          progress.inFlight = false
        })
        assertOperation()
      }
      await showCursor(point.x, point.y, 'type')
      assertOperation()
      return { typed: progress.typed }
    }
    for (const character of characters) {
      point = await resolveTarget(ref, 'typing')
      await cdp('Input.insertText', { text: character })
      await delay(18)
    }
    await showCursor(point.x, point.y, 'type')
    await delay(50)
    return { typed: characters.length }
  }

  async function insertText(text) {
    const frame = contents.focusedFrame
    const version = documentVersion
    const editable = frame && await whileLive(() => frame.executeJavaScript(`(() => {
      let el = document.activeElement
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
      if (!el || el.closest('[inert]') || el.matches(':disabled') || el.readOnly) return false
      if (el.tagName === 'INPUT') return ['text','search','email','url','tel','password','number'].includes(el.type)
      if (el.tagName === 'TEXTAREA' || el.isContentEditable || el.editContext) return true
      if (el === document.body || el === document.documentElement) return false
      // 封闭 shadow tree 内的选区会映射为宿主节点。单查编辑命令会误认已失焦编辑器的旧选区。
      const range = document.getSelection()?.getComposedRanges()[0]
      return !!range && range.startContainer === range.endContainer && range.endOffset === range.startOffset + 1
        && range.startContainer.childNodes[range.startOffset] === el && document.queryCommandEnabled('insertText')
    })()`))
    assertOperation()
    if (!editable) throw new Error('no focused editable target; focus a text field or editor before inserting text')
    await whileLive(() => {
      assertOperation()
      if (frame !== contents.focusedFrame || version !== documentVersion) throw new Error('input focus or page changed before text dispatch')
      return contents.debugger.sendCommand('Input.insertText', { text })
    })
    assertOperation()
    return { typed: Array.from(text).length }
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
    if (args.selector !== undefined && !selector.trim()) throw new TypeError('wait selector must be a non-empty CSS selector')
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
      } catch (error) {
        assertOperation()
        // 仅导航切换执行上下文时重新查询；语法错误等永久错误应立即交还调用方。
        const contextLost = /^(?:Protocol error \(Runtime\.evaluate\): )?(?:execution context was destroyed|cannot find (?:default execution context|context with specified id)|inspected target navigated or closed)/i
        if (!contextLost.test(error.message)) throw error
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

  async function readText(message) {
    const maxChars = message.maxChars === undefined ? 6000 : message.maxChars
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > READ_MAX_CHARS) {
      throw new TypeError('read maxChars must be an integer between 1 and 24000')
    }
    let selector = message.selector === undefined ? '' : message.selector
    if (typeof selector !== 'string' || (message.selector !== undefined && selector.trim() === '')) {
      throw new TypeError('read selector must be a non-empty CSS selector when provided')
    }
    let offset = 0
    let cursorToken
    if (message.cursor !== undefined) {
      if (typeof message.cursor !== 'string' || message.cursor.length > 4096
        || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(message.cursor)) throw new TypeError('read cursor is invalid')
      const [payload, signature] = message.cursor.split('.')
      if (createHmac('sha256', readCursorKey).update(payload).digest('base64url') !== signature) {
        throw new Error('stale read cursor; wrong window or invalid cursor, read again')
      }
      let token
      try { token = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw new TypeError('read cursor is invalid') }
      if (token?.format !== 1 || token.version !== documentVersion || typeof token.selector !== 'string'
        || (message.selector !== undefined && token.selector !== selector)
        || typeof token.fingerprint !== 'string' || !Number.isSafeInteger(token.offset) || token.offset < 1) {
        throw new Error('stale read cursor; page or selector changed, read again')
      }
      cursorToken = token
      selector = token.selector
      offset = token.offset
    }
    const version = documentVersion
    const result = await evaluate(`(() => {
      const selector = ${JSON.stringify(selector)}
      const root = selector ? document.querySelector(selector) : document.body
      if (!root) throw new Error(selector ? 'read selector did not match an element' : 'page has no body to read')
      if (!(root instanceof HTMLElement)) throw new Error('read target must be an HTML element')
      const style = getComputedStyle(root)
      let rendered = false
      if (style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) !== 0 && !root.closest('[hidden]')) {
        if (style.display === 'contents') {
          // 该容器没有自己的盒子，Range 也能检测直接文本节点的布局，不改动页面选区。
          const range = document.createRange()
          range.selectNodeContents(root)
          rendered = range.getClientRects().length > 0
        } else rendered = root.getClientRects().length > 0
      }
      // innerText on an unrendered root can fall back to textContent and expose hidden text.
      const text = rendered ? root.innerText : ''
      let hashA = 2166136261
      let hashB = 2654435769
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index)
        hashA = Math.imul(hashA ^ code, 16777619) >>> 0
        hashB = Math.imul(hashB ^ (code + index), 2246822519) >>> 0
        hashB ^= hashB >>> 13
      }
      const fingerprint = text.length.toString(36) + '.' + hashA.toString(36) + '.' + hashB.toString(36)
      const start = ${offset}
      const limit = ${maxChars}
      if (start > text.length) throw new Error('stale read cursor; page content became shorter, read again')
      let end = Math.min(start + limit, text.length)
      if (end > 0 && end < text.length
        && /[\\uD800-\\uDBFF]/.test(text[end - 1]) && /[\\uDC00-\\uDFFF]/.test(text[end])) end--
      if (start < text.length && end === start) throw new Error('read maxChars is too small for the next Unicode character; increase maxChars to at least 2')
      return {
        url: location.href, title: document.title, text: text.slice(start, end),
        totalChars: text.length, offset: start, returnedChars: end - start, truncated: end < text.length, fingerprint,
      }
    })()`)
    if (version !== documentVersion) throw new Error('page changed during read; read again')
    if (cursorToken && result.fingerprint !== cursorToken.fingerprint) {
      throw new Error('stale read cursor; page content changed, read again')
    }
    const nextOffset = result.offset + result.returnedChars
    const hasMore = result.offset + result.returnedChars < result.totalChars
    let nextCursor
    if (hasMore) {
      const payload = Buffer.from(JSON.stringify({ format: 1, version, selector, offset: nextOffset, fingerprint: result.fingerprint }), 'utf8').toString('base64url')
      nextCursor = payload + '.' + createHmac('sha256', readCursorKey).update(payload).digest('base64url')
      if (nextCursor.length > 4096) throw new Error('read selector is too long for a continuation cursor; use a shorter selector')
    }
    const { fingerprint, ...page } = result
    return { ...page, hasMore, ...hasMore ? { nextCursor } : {} }
  }

  async function dispatch(message) {
    assertLive()
    switch (message.op) {
      case 'navigate':
        return navigate(message.url)
      case 'snapshot':
        return snapshot(message)
      case 'click':
        return click(message.ref)
      case 'hover':
        return hover(message.ref)
      case 'type':
        return type(message.ref, String(message.text ?? ''), message.mode)
      case 'insertText':
        return insertText(String(message.text ?? ''))
      case 'scroll':
        return scroll(message)
      case 'key':
        return pressKeyChord(message.key)
      case 'screenshot':
        return screenshot()
      case 'eval': {
        // eval 的页面异常是内层业务结果 ok: false，不改变外层 RPC 成功信封。
        try {
          const value = await evaluate(message.expression)
          const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? null)
          let end = Math.min(serialized.length, EVAL_RESULT_MAX_CHARS)
          if (end > 0 && end < serialized.length
            && /[\uD800-\uDBFF]/.test(serialized[end - 1])
            && /[\uDC00-\uDFFF]/.test(serialized[end])) end--
          return {
            ok: true,
            value: serialized.slice(0, end),
            truncated: end < serialized.length,
          }
        } catch (error) {
          assertOperation()
          return { ok: false, exception: String(error && error.message ? error.message : error) }
        }
      }
      case 'wait':
        return waitFor(message)
      case 'state':
        return pageState()
      case 'read':
        return readText(message)
      case 'pdf':
        return nativeUI.pdf()
      case 'back':
        return traverseHistory('back', true)
      case 'reload':
        return navigateAndWait(() => cdp('Page.reload', { ignoreCache: false }, true), 10_000)
      default:
        throw new Error(`unknown op: ${message.op}`)
    }
  }

  downloadOwners.set(contents, record)
  nativeUI = createNativeUI({
    contents,
    version: () => documentVersion,
    interrupt: message => {
      if (activeJob) cancelRequest(activeJob, new Error(message))
      for (const job of record.jobs) if (job.message.op === 'upload') cancelRequest(job, new Error(message))
    },
    assertLive,
    assertOperation,
    whileLive,
    command: (method, params, guard) => whileLive(() => {
      guard?.()
      return contents.debugger.sendCommand(method, params)
    }),
    directory: downloadDirectory,
    remainingDiskBudget: downloadSpace,
    enabled: { files: componentEnabled('files'), requests: componentEnabled('requests') },
  })
  nativeControllers.set(contents, nativeUI)
  contents.on('did-start-navigation', (details, _url, _inPlace, legacyMain) => {
    if ((details.isMainFrame ?? legacyMain) === true) invalidateRefs()
    else nativeUI.invalidate()
  })
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) invalidateRefs()
    else nativeUI.invalidate()
  })

  contents.on('destroyed', () => dispose())
  contents.on('render-process-gone', (_event, details) => dispose(new Error(`renderer gone: ${details.reason}`)))
  contents.on('preload-error', (_event, path, error) => dispose(new Error(`background UI preload failed (${path}): ${error.message}`)))
  record.ready = (async () => {
    if (!adopted) await whileLive(() => contents.loadURL('about:blank'))
    assertLive()
    contents.debugger.attach('1.3')
    await cdp('Page.enable')
    contents.debugger.on('message', (_event, method, params) => {
      if (method !== 'Page.fileChooserOpened' || disposed) return
      nativeUI.fileChooser(params).catch(error => {
        console.error(`[dsh-browser-use-automation] file chooser interception failed: ${error.message}`)
      })
    })
    await cdp('Page.setInterceptFileChooserDialog', { enabled: true })
    assertLive()
  })().catch(error => { dispose(error); throw error })
  record.ready.catch(() => {})
  return record
}

function createConversation(conversationId) {
  const windowNumber = ++nextWindowNumber
  const title = `dsh-browser-use-automation #${windowNumber}`
  let win = null
  let toolbarContents
  let retireSession
  let revealReady = false
  let disposed = false
  // 原生关闭意图只属于这一代记录；RPC close/reset、初始化失败和宿主退出
  // 均不设置它，避免程序销毁最后一个窗口时误把可复用的宿主也退出。
  let nativeCloseRequested = false
  let failure = null
  let watch = null
  // Windows 为原生缩略图保留不透明绘制表面，不能再以 opacity 判断是否在人工查看。
  // transitioning 防止内部恢复/隐藏触发的 focus 被当作用户点击任务栏预览。
  let backgrounded = true
  let transitioning = false
  const timers = new Set()
  const tabs = new Map()
  let active
  let browserSession
  const record = {
    windowNumber, conversationId, lastUsed: ++lastUse, tabs, jobs: new Set(),
    ready: null, assertLive, dispose, isReady, revealWindow, hideToBackground,
    target, tabAction, windowAction,
    beforePageAction() {
      if (isReady() && !backgrounded && !appActive()) hideToBackground()
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

  if (!downloadRecords.has(conversationId)) downloadRecords.set(conversationId, [])

  function assertLive() {
    if (disposed) throw failure
    if (win !== null && win.isDestroyed()) {
      dispose()
      throw failure
    }
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

  function dispose(error = new Error('conversation window closed')) {
    if (disposed) return
    disposed = true
    failure = error
    revealReady = false
    for (const timer of timers) clearTimeout(timer)
    if (watch !== null) clearInterval(watch)
    for (const job of record.jobs) cancelRequest(job, error)
    toolbars.delete(toolbarContents)
    for (const tab of tabs.values()) tab.dispose(error)
    // 旧窗口的延迟事件不得删除同一对话后来创建的新记录。
    if (windows.get(conversationId) === record) windows.delete(conversationId)
    if (win !== null && !win.isDestroyed()) win.destroy()
    retireSession?.()
    updateDockMenu()
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
      // macOS 的 setFocusable(false) 不释放已有 key window；收回人工查看窗口时需先失焦。
      if (win.isFocused()) win.blur()
      setBackgroundProperties()
      showInactiveInBackground()
      return { hidden: true, bounds: win.getBounds(), opacity: win.getOpacity(), visible: win.isVisible() }
    } finally {
      transitioning = false
    }
  }

  function target(id) {
    const tab = id === undefined ? active : tabs.get(id)
    if (!tab) throw new Error('unknown or closed browser tab')
    return tab
  }

  function state() {
    return { activeTabId: active?.id ?? '', tabs: Array.from(tabs.values(), ({ id, contents }) => ({
      id, title: contents.getTitle(), url: contents.getURL() || 'about:blank',
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
    })) }
  }

  function notify() {
    if (!disposed && !toolbarContents.isDestroyed()) toolbarContents.send('dsh:tabs', state())
  }

  function layout(tab) {
    const [width, height] = win.getContentSize()
    tab.view.setBounds({ x: 0, y: 84, width, height: Math.max(0, height - 84) })
  }

  function select(tab, focusPage = false) {
    const focus = !backgrounded && win.isFocused()
      && (focusPage || (active !== tab && active && !active.contents.isDestroyed() && active.contents.isFocused()))
    active = tab
    win.contentView.addChildView(tab.view)
    layout(tab)
    if (focus) tab.contents.focus()
    notify()
  }

  function remove(tab, error) {
    if (!tabs.delete(tab.id)) return
    if (win.isDestroyed()) { dispose(error); return }
    win.contentView.removeChildView(tab.view)
    if (disposed) return
    if (active === tab) {
      active = undefined
      if (tabs.size) select(Array.from(tabs.values()).at(-1), !win.webContents.isFocused())
      else dispose(error)
    } else notify()
  }

  function focusAddress() {
    if (backgrounded || !win.isFocused()) return
    win.webContents.focus()
    win.webContents.send('dsh:address')
  }

  function shortcut(event, input) {
    if (backgrounded || !win.isFocused() || input.type !== 'keyDown' || input.isAutoRepeat
      || input.alt || input.shift || !(process.platform === 'darwin' ? input.meta : input.control)) return
    switch (input.key.toLowerCase()) {
      case 'l': event.preventDefault(); focusAddress(); break
      case 't': event.preventDefault(); openTab(); focusAddress(); break
      case 'w': event.preventDefault(); closeTab(active); break
    }
  }

  function pagePreferences() {
    return { session: browserSession, sandbox: true, nodeIntegration: false, contextIsolation: true,
      nodeIntegrationInSubFrames: true, backgroundThrottling: false, disableDialogs: true }
  }

  function openTab(options, activate = true) {
    assertLive()
    const view = new WebContentsView({ ...options, webPreferences: pagePreferences() })
    const tab = createTab(conversationId, view, Boolean(options), remove)
    tabs.set(tab.id, tab)
    const contents = tab.contents
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (url !== 'about:blank' && !/^https?:/i.test(url)) return { action: 'deny' }
      return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences: pagePreferences() },
        createWindow(childOptions) {
          return openTab(childOptions, active === tab && disposition !== 'background-tab').contents
        } }
    })
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) contents.on(event, notify)
    contents.on('before-input-event', (event, input) => { if (active === tab) shortcut(event, input) })
    if (activate || !active) select(tab)
    else {
      win.contentView.addChildView(view)
      layout(tab)
      select(active)
    }
    return tab
  }

  function closeTab(tab) {
    const replacement = tabs.size === 1 ? openTab() : undefined
    tab.dispose()
    return replacement
  }

  async function tabAction(action, id, { first = false, manual = false } = {}) {
    let created
    switch (action) {
      case 'list': break
      case 'new': created = first ? target() : openTab(); break
      case 'select': select(target(id), manual); break
      case 'close': created = closeTab(target(id)); break
      default: throw new Error('unknown browser tab action')
    }
    const result = state()
    if (manual && action === 'new') focusAddress()
    if (created) await created.ready
    return result
  }

  function toolbarAction(action, id, value) {
    if (['list', 'new', 'select', 'close'].includes(action)) return tabAction(action, id, { manual: true })
    return target(id).manualNavigation(action, value)
  }

  function windowAction(op) {
    switch (op) {
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
    }
  }

  async function initialize() {
    assertLive()
    if (SESSION_MODE === 'shared') {
      browserSession = session.defaultSession
      sessionUsed = true
    } else {
      // A unique non-persistent partition is never reused, even while clearing it asynchronously.
      browserSession = session.fromPartition(`dsh-browser-isolated-${windowNumber}`, { cache: false })
      const uninstall = installNativeSession(browserSession, nativeControllers)
      browserSession.on('will-download', handleDownload)
      retireSession = () => {
        // Keep the download handler to deny late events from the retired partition.
        Promise.resolve().then(async () => {
          uninstall()
          await browserSession.closeAllConnections()
          await browserSession.clearData()
          await browserSession.clearCache()
        }).catch(error => console.error(`[dsh-browser-use-automation] isolated session cleanup failed: ${error.message}`))
      }
    }
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT, minHeight: 160,
      show: false,
      focusable: WINDOWS_TASKBAR,
      title,
      skipTaskbar: !WINDOWS_TASKBAR,
      webPreferences: { partition: 'dsh-browser-toolbar', preload: join(__dirname, 'toolbar-preload.cjs'),
        sandbox: true, nodeIntegration: false, contextIsolation: true, zoomFactor: 1 },
    })
    toolbarContents = win.webContents
    toolbarContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    toolbars.set(win.webContents, toolbarAction)
    win.webContents.on('before-input-event', shortcut)
    win.on('resize', () => { for (const tab of tabs.values()) layout(tab) })
    setBackgroundProperties()
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
    win.webContents.on('preload-error', (_event, path, error) => {
      // 不能在桥接失效后继续让页面偷偷回到原生弹框或默认拒绝，必须明确中止当前窗口。
      dispose(new Error(`background UI preload failed (${path}): ${error.message}`))
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
      // 恢复前必须先撤掉人工查看时的可聚焦性，否则 macOS deminiaturize 会短暂打断前台输入。
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
            setBackgroundProperties({ updateTaskbar: false })
            if (win.isFocused()) win.blur()
            win.setOpacity(0)
            park()
            win.restore()
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
    openTab()
    await win.loadFile(join(__dirname, 'toolbar.html'))
    assertLive()
    setBackgroundProperties()
    try {
      win.setMinimizable(false)
    } catch {
      // 部分平台不支持禁用最小化，失败不阻断启动。
    }
    // 首次显示前也先透明，避免非激活窗口的原生表面短暂覆盖前台；仍保留 CDP 绘制表面。
    showInactiveInBackground()
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

  // 同步登记初始标签，使首批请求在等待工具栏就绪前就能绑定目标。
  windows.set(conversationId, record)
  updateDockMenu()
  record.ready = initialize().catch(error => {
    dispose(error)
    throw error
  })
  // 首请求可能在初始化完成前就被取消/重置；仍必须消费 ready 的拒绝，避免进程告警。
  // 原 Promise 保留失败状态，尚在等待它的有效请求仍会得到同一错误。
  record.ready.catch(() => {})
  return record
}

function addressURL(value) {
  const address = typeof value === 'string' ? value.trim() : ''
  if (!address || /[\s\u0000-\u001f]/u.test(address)) throw new Error('请输入有效的 HTTP 或 HTTPS 网址')
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(address) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(address)
  const url = new URL(hasScheme ? address : 'https://' + address)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('地址栏支持 HTTP 和 HTTPS 网址')
  return url.href
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
  const fail = error => send({ id: message.id, ok: false, error: String(error && error.message ? error.message : error) })
  if (message.op === 'components') {
    try { configureComponents(message.enabled); send({ id: message.id, ok: true, result: { configured: true } }) } catch (error) { fail(error) }
    return
  }
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
  if (message.component !== undefined && (!componentEnabled(message.component)
    || !componentDefinitions[message.component]?.operations.includes(message.op))) {
    fail(new Error(`browser component is disabled or does not allow this operation: ${message.component}`))
    return
  }
  if ((['upload', 'pdf', 'downloads'].includes(message.op) && !componentEnabled('files'))
    || (['requests', 'respond', 'upload'].includes(message.op) && !componentEnabled('requests'))) {
    fail(new Error('required browser file/request component is disabled'))
    return
  }
  if (quitting) {
    fail(new Error('host shutting down'))
    return
  }
  let record = windows.get(message.conversationId)
  if (message.op === 'downloads') {
    // 下载查询不能排在卡住的页面导航后，也不能仅为查询创建新窗口或触发下载重试。
    send({ id: message.id, ok: true, result: { downloads: downloadRecords.get(message.conversationId) || [] } })
    return
  }
  if (message.op === 'close' || message.op === 'reset') {
    record?.dispose(new Error(`conversation window ${message.op === 'reset' ? 'reset' : 'closed'}`))
    send({ id: message.id, ok: true, result: message.op === 'reset' ? { reset: true } : { closed: true } })
    return
  }
  const reply = result => send({ id: message.id, ok: true, result })
  try {
    if (message.op === 'tabs') {
      if (!['list', 'new', 'select', 'close'].includes(message.action)) throw new Error('unknown browser tab action')
      if (['select', 'close'].includes(message.action) && typeof message.tabId !== 'string') throw new Error('tabId is required')
      const first = !record
      if (!record) {
        if (message.action === 'list') { reply({ activeTabId: '', tabs: [] }); return }
        if (message.action !== 'new') throw new Error('unknown or closed browser tab')
        record = createConversation(message.conversationId)
      }
      const job = createRequestJob(message, record)
      Promise.all([record.ready, record.tabAction(message.action, message.tabId, { first })])
        .then(([, result]) => finishRequest(job, null, result), error => finishRequest(job, error))
      return
    }
    if (message.op === 'requests') {
      if (message.tabId !== undefined && !record) throw new Error('unknown or closed browser tab')
      const selected = message.tabId !== undefined ? [record.target(message.tabId)] : Array.from(record?.tabs.values() || [])
      const result = { requests: [], audit: [] }
      for (const tab of selected) {
        const status = tab.status()
        for (const key of ['requests', 'audit']) result[key].push(...status[key].map(item => ({ ...item, tabId: tab.id })))
      }
      reply(result)
      return
    }
    if (message.op === 'respond' || message.op === 'upload') {
      const tab = message.tabId !== undefined ? record?.target(message.tabId)
        : Array.from(record?.tabs.values() || []).find(tab => tab.status().requests.some(item => item.id === message.requestId))
      if (!tab) throw new Error('stale browser request or no live conversation window for this browser request')
      const job = createRequestJob(message, tab)
      Promise.resolve().then(() => tab.nativeRequest(message, job))
        .then(result => finishRequest(job, null, result), error => finishRequest(job, error))
      return
    }
    if (!record && message.tabId !== undefined) throw new Error('unknown or closed browser tab')
    record ??= createConversation(message.conversationId)
    if (['windowShow', 'windowHide', 'windowState'].includes(message.op)) {
      const job = createRequestJob(message, record)
      record.ready.then(() => {
        if (job.done) return
        record.assertLive()
        finishRequest(job, null, record.windowAction(message.op))
      }).catch(error => finishRequest(job, error))
      return
    }
    // Capture the target before awaiting initialization or an earlier job.
    const tab = record.target(message.tabId)
    tab.assertPageAvailable()
    const job = createRequestJob(message, tab)
    tab.queue = tab.queue.then(async () => {
      try {
        await record.ready
        await tab.ready
        if (job.done) return
        tab.assertLive()
        record.lastUsed = ++lastUse
        record.beforePageAction()
        const result = await tab.execute(job)
        tab.assertLive()
        finishRequest(job, null, result)
      } catch (error) { finishRequest(job, error) }
    })
  } catch (error) { fail(error) }
}

function onConnection(connection) {
  if (quitting || socket !== null || handshakes.size >= HANDSHAKE_CONNECTION_LIMIT) {
    connection.destroy()
    return
  }
  handshakes.add(connection)
  let input = ''
  let helloBytes = 0
  const deadline = setTimeout(() => connection.destroy(), HANDSHAKE_TIMEOUT_MS)
  const endHandshake = () => {
    clearTimeout(deadline)
    handshakes.delete(connection)
  }
  connection.setEncoding('utf8')
  connection.on('data', chunk => {
    if (connection.destroyed) return
    input += chunk
    while (!connection.destroyed) {
      const newline = input.indexOf('\n')
      const bound = newline < 0 ? input.length : newline
      if (socket === connection) {
        if (Buffer.byteLength(input.slice(0, bound)) > RPC_BUFFER_LIMIT) return connection.destroy()
        if (newline < 0) return
        const line = input.slice(0, newline)
        input = input.slice(newline + 1)
        if (line.trim() !== '') onLine(line)
        continue
      }
      const bytes = Buffer.byteLength(input.slice(0, bound)) + (newline < 0 ? 0 : 1)
      if (helloBytes + bytes > HANDSHAKE_BUFFER_LIMIT) return connection.destroy()
      if (newline < 0) return
      helloBytes += bytes
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      if (line.trim() === '') continue
      let hello
      try { hello = JSON.parse(line) } catch { return connection.destroy() }
      const supplied = typeof hello?.token === 'string' ? Buffer.from(hello.token) : null
      if (quitting || socket !== null || hello?.op !== 'hello' || hello.id !== 0
        || supplied?.length !== TOKEN.length || !timingSafeEqual(supplied, TOKEN)) return connection.destroy()
      socket = connection
      endHandshake()
      for (const other of handshakes) other.destroy()
      send({ id: 0, ok: true, result: { pid: process.pid } })
    }
  })
  connection.on('error', () => connection.destroy())
  connection.on('close', () => {
    endHandshake()
    if (socket !== connection) return
    socket = null
    quitHost()
  })
}

async function start() {
  const configured = process.env.BROWSER_USE_DOWNLOAD_DIR
  if (configured !== undefined && (!configured || !isAbsolute(configured))) {
    throw new Error('BROWSER_USE_DOWNLOAD_DIR must be an absolute directory path')
  }
  downloadDirectory = resolve(configured || join(process.env.DSH_HOME || join(app.getPath('home'), '.dsh'), 'browser-use', 'downloads'))
  ipcMain.handle('dsh:toolbar', (event, action, id, value) => {
    const handle = toolbars.get(event.sender)
    if (!handle || event.senderFrame !== event.sender.mainFrame) throw new Error('unknown toolbar')
    return handle(action, id, value)
  })
  installNativeIPC(ipcMain, nativeControllers)
  if (SESSION_MODE === 'shared') {
    session.defaultSession.on('will-download', handleDownload)
    installNativeSession(session.defaultSession, nativeControllers)
  }
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
    console.error(`[dsh-browser-use-automation] rpc server error: ${error.message}`)
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
  console.error(`[dsh-browser-use-automation] host failed: ${error && error.stack ? error.stack : error}`)
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
