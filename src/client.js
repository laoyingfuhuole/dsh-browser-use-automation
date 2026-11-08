/**
 * 插件侧的浏览器客户端（JavaScript，不是 Java）。
 *
 * 本文件运行在 DSH 的 Node 环境；一个共享 Electron 子进程承载多个对话窗口。
 * 每个请求携带 conversationId，host 将它分配到对应窗口的独立操作队列；
 * TCP 连接、认证和进程生命周期共用，页面及 ref 不共用，登录存储共用。
 * 二者通过本机 TCP 交换一行一个的 JSON 消息，先用随机 token 认证，再执行操作。
 * 一次启动经历：创建进程 → 读取端口 → 连接 TCP → hello 认证 → 可执行工具。
 * 插件卸载、启动失败或连接断开时，统一释放子进程及未完成的调用。
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST_ENTRY = fileURLToPath(new URL('../host/main.cjs', import.meta.url))
const READY_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 60_000

/**
 * 查找可以直接执行 host/main.cjs 的 Electron 程序，不复用已打包的 DSH 应用。
 * 顺序：ELECTRON_PATH 显式路径 → 本包依赖 → DSH 各 profile 的 Electron。
 * 这里只读取安装路径，不执行安装脚本，也不会自动下载依赖。
 * @returns {string} Electron 可执行文件的本机路径。
 */
export function resolveElectronPath() {
  const override = process.env.ELECTRON_PATH
  if (typeof override === 'string' && override.length > 0 && existsSync(override)) return override

  try {
    // ESM 文件通过 createRequire 使用包解析；resolve 只定位文件，不执行模块。
    // path.txt 保存安装程序选择的可执行路径，其后是各平台默认目录的兜底。
    const require = createRequire(import.meta.url)
    const entry = require.resolve('electron')
    const root = dirname(entry)
    const pathFile = join(root, 'path.txt')
    if (existsSync(pathFile)) {
      const relative = readFileSync(pathFile, 'utf8').trim()
      const candidate = join(root, 'dist', relative)
      if (existsSync(candidate)) return candidate
    }
    for (const relative of [
      join('dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
      join('dist', 'electron'),
      join('dist', 'electron.exe'),
    ]) {
      const candidate = join(root, relative)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // 本包虽声明了 Electron 依赖，本地安装仍可能不完整；继续查找 profile。
  }

  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profiles = join(home, 'profiles')
  if (existsSync(profiles)) {
    let names = []
    try {
      names = readdirSync(profiles)
    } catch {
      names = []
    }
    for (const name of names) {
      const root = join(profiles, name, 'node_modules', 'electron', 'dist')
      const candidates = [
        join(root, 'Electron.app', 'Contents', 'MacOS', 'Electron'),
        join(root, 'electron'),
        join(root, 'electron.exe'),
      ]
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
      }
    }
  }

  throw new Error(
    'dsh-browser-use: no spawnable Electron binary. Install Electron (`npm install electron`), '
    + 'set ELECTRON_PATH to a bare Electron executable, or install it into the DSH profile.',
  )
}

/**
 * 将一次事件等待转换为 Promise；readValue 返回 undefined 时表示数据尚未完整。
 * 事件完成、超时和取消共用 finish，避免遗留计时器或监听器。
 * signal 属于整次 host 启动，不是某个工具调用：销毁 host 时能立即中止等待。
 */
function waitForEvent(emitter, event, readValue, signal, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer)
      emitter.off(event, onEvent)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value)
    }
    const onEvent = (...args) => {
      try {
        const value = readValue(...args)
        if (value !== undefined) finish(null, value)
      } catch (error) {
        finish(error)
      }
    }
    const onAbort = () => finish(signal.reason)
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs)
    emitter.on(event, onEvent)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

/**
 * 等待共享启动，但允许一个调用者提前离开。取消只结束本次等待，不会把其他
 * 调用共用的 Electron 启动一起取消。Promise 的成功/失败处理仍保留，接住后续结果。
 */
function waitForStartup(starting, signal) {
  if (!signal) return starting
  return new Promise((resolve, reject) => {
    const finish = (handler, value) => {
      signal.removeEventListener('abort', onAbort)
      handler(value)
    }
    const onAbort = () => finish(reject, new Error('browser operation aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    starting.then(value => finish(resolve, value), error => finish(reject, error))
    if (signal.aborted) onAbort()
  })
}

/** 管理一个按需启动的 host：构造对象不会启动进程，首次 call 才会启动。 */
export class HostClient {
  /** @param {{width?: number, height?: number}} [options] */
  constructor(options = {}) {
    this.options = options
    this.child = null
    this.socket = null
    this.nextId = 1
    // Map 用请求 id 保存尚未完成的 Promise；收到响应时找到对应调用者。
    this.pending = new Map()
    this.starting = null
    this.lifecycle = null
    this.buffer = ''
    this.stderr = ''
  }

  /**
   * 发送一个工具操作。await 只等待异步结果，不会阻塞整个 Node 进程。
   * 已取消的调用不启动浏览器；启动中的取消也不会继续发送该操作。
   * 取消/超时立即结束客户端等待，并尽力通知 host 跳过排队操作，或在当前
   * CDP 调用结束后停止后续步骤；点击的按下/松开属于最小配对清理，可能完成。
   * 不会强行终止已运行的页面脚本，也不回滚已发生的导航、点击等页面效果，
   * 更不会自动关闭窗口、重置或重试。旧操作未真正结束时，其窗口队列仍会等待。
   * @param {string} op host 操作名，与工具名不同，例如 navigate。
   * @param {{conversationId: string} & Record<string, unknown>} payload 对话 ID 与操作参数。
   * @param {AbortSignal} [signal] 由工具执行器提供的取消信号。
   * @returns {Promise<unknown>} host 返回的操作结果。
   */
  async call(op, payload = {}, signal) {
    if (signal?.aborted) throw new Error('browser operation aborted')
    const conversationId = payload?.conversationId
    if (typeof conversationId !== 'string' || conversationId.trim() === '') {
      throw new TypeError('browser operation requires a non-empty conversationId')
    }
    // 发起调用时捕获参数，避免等待 host 启动期间调用者修改对象而串到别的窗口。
    // request id/op 由客户端控制，conversationId 由工具的 exec.agent.id 提供。
    const message = { ...payload, conversationId, op }
    const starting = this.ensureStarted()
    const lifecycle = this.lifecycle
    await waitForStartup(starting, signal)
    if (signal?.aborted) throw new Error('browser operation aborted')
    if (this.lifecycle !== lifecycle) throw new Error('browser host changed before the command was sent')
    // close/reset 只显式销毁此对话的窗口。共享 host 及其他对话继续运行；只有
    // dispose（插件卸载或连接故障）才释放子进程，不能在这里自动重建或杀掉它。
    return this.request({ ...message, id: this.nextId++ }, CALL_TIMEOUT_MS, signal)
  }

  ensureStarted() {
    // 必须先等待 starting：TCP 已连接不代表 hello 认证已经完成。
    if (this.starting !== null) return this.starting
    if (this.socket !== null && !this.socket.destroyed) return Promise.resolve()
    const lifecycle = new AbortController()
    this.lifecycle = lifecycle
    const starting = this.start(lifecycle.signal).catch(error => {
      // 旧启动稍后失败时，不能清理已经重启的新一代进程。
      if (this.lifecycle === lifecycle) this.dispose(error)
      throw error
    }).finally(() => {
      if (this.starting === starting) this.starting = null
    })
    this.starting = starting
    return starting
  }

  async start(signal) {
    const electron = resolveElectronPath()
    const token = randomBytes(24).toString('hex')
    const env = { ...process.env, BROWSER_USE_TOKEN: token }
    // DSH 自身可能设置此变量；子进程必须运行 Electron，而不是普通 Node。
    delete env.ELECTRON_RUN_AS_NODE
    env.BROWSER_USE_WIDTH = String(this.options.width || 1400)
    env.BROWSER_USE_HEIGHT = String(this.options.height || 900)
    this.buffer = ''
    this.stderr = ''

    const child = spawn(electron, [HOST_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      if (this.child === child) this.stderr = (this.stderr + chunk).slice(-4000)
    })
    child.on('error', error => {
      if (this.child === child) this.dispose(error)
    })
    child.on('exit', (code, exitSignal) => {
      if (this.child !== child) return
      this.dispose(new Error(`browser host exited (code=${code}, signal=${exitSignal})${this.stderr ? `: ${this.stderr}` : ''}`))
    })

    // stdout 仅负责启动通知；真正的操作通过独立 TCP 通道传输。
    // 一行 JSON 可能分多块到达，必须等到换行后再解析。
    let output = ''
    child.stdout.setEncoding('utf8')
    const port = await waitForEvent(child.stdout, 'data', chunk => {
      output += chunk
      const newline = output.indexOf('\n')
      if (newline < 0) return
      try {
        const { port } = JSON.parse(output.slice(0, newline))
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
        return port
      } catch {
        throw new Error(`browser host sent invalid ready line: ${output.slice(0, 200)}`)
      }
    }, signal, READY_TIMEOUT_MS, `browser host did not become ready in ${READY_TIMEOUT_MS}ms`)
    signal.throwIfAborted()

    const socket = connect({ host: '127.0.0.1', port })
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      if (this.socket === socket) this.onData(chunk)
    })
    socket.on('error', error => {
      if (this.socket === socket) this.dispose(error)
    })
    socket.on('close', () => {
      if (this.socket === socket) this.dispose(new Error('browser host connection closed'))
    })
    await waitForEvent(socket, 'connect', () => true, signal, 5000, 'browser host connection timed out')
    signal.throwIfAborted()
    // id 0 留给认证；普通操作从 1 开始。认证也使用同一套请求清理逻辑。
    await this.request({ id: 0, op: 'hello', token }, 5000, signal)
    signal.throwIfAborted()
  }

  /**
   * 普通操作与 hello 共用的 RPC 请求。无论完成路径为何，都只能结算一次，
   * 且必须同时删除 pending、取消计时器、移除 abort 监听器。
   */
  request(message, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const socket = this.socket
      const lifecycle = this.lifecycle
      const { id, op, conversationId } = message
      let settled = false
      let sent = false
      let cancellationRequested = false
      let cancellationSent = false
      // cancel 是无需响应的通知，不分配 id/pending，也不启动或重启 host。
      // 捕获原连接、生命周期和对话 ID，防止旧请求取消到后来创建的连接/窗口。
      const sendCancel = () => {
        if (!sent || cancellationSent || op === 'hello' || op === 'cancel') return
        if (this.socket !== socket || this.lifecycle !== lifecycle || lifecycle?.signal.aborted) return
        if (socket === null || socket.destroyed || socket.writable === false) return
        cancellationSent = true
        try {
          socket.write(`${JSON.stringify({ op: 'cancel', requestId: id, conversationId })}\n`, () => {})
        } catch {
          // 取消是尽力通知；发送失败不覆盖原来的取消/超时错误，也不重试操作。
        }
      }
      const settle = (handler, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        handler(value)
      }
      const cancel = error => {
        if (settled) return
        cancellationRequested = true
        settle(reject, error)
        sendCancel()
      }
      const onAbort = () => cancel(new Error('browser operation aborted'))
      const timer = setTimeout(() => {
        cancel(new Error(`browser host timed out after ${timeoutMs}ms on ${op}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => settle(resolve, value),
        reject: error => settle(reject, error),
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }
      try {
        const line = `${JSON.stringify(message)}\n`
        // toJSON 也可能触发取消；尚未写入 socket 时不能发送原操作或 cancel。
        if (settled) return
        if (socket === null || socket.destroyed || socket.writable === false
          || this.socket !== socket || this.lifecycle !== lifecycle || lifecycle?.signal.aborted) {
          settle(reject, new Error('browser host connection closed before the command was sent'))
          return
        }
        socket.write(line, error => {
          if (error) settle(reject, error)
        })
        // write 返回 false 只表示背压，消息仍已提交；抛错则不会执行到这里。
        sent = true
        if (cancellationRequested) sendCancel()
      } catch (error) {
        settle(reject, error)
      }
    })
  }

  /** TCP 是字节流：可能收到半条消息或多条消息，buffer 保留尚未到换行的部分。 */
  onData(chunk) {
    this.buffer += chunk
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.dispose(new Error('browser host response exceeded buffer limit'))
      return
    }
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (line.trim() === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message === null || typeof message !== 'object') continue
      const pending = this.pending.get(message.id)
      // 超时/取消后的迟到响应没有调用者，应忽略而不是重用。
      if (pending === undefined) continue
      if (message.ok === true) pending.resolve(message.result)
      else pending.reject(new Error(message.error || 'browser host error'))
    }
  }

  /**
   * 统一释放连接和子进程，可以重复调用。先断开对象引用，再关闭实际资源，
   * 这样旧资源稍后触发的 exit/close 回调不会误伤新启动的 host。
   */
  dispose(error = new Error('browser host disposed')) {
    const { child, socket, lifecycle } = this
    this.child = null
    this.socket = null
    this.lifecycle = null
    this.starting = null
    this.buffer = ''
    this.stderr = ''
    // 先把原始错误交给请求，再取消启动等待，避免把断连误报成用户取消。
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    lifecycle?.abort(error)
    socket?.destroy()
    if (child !== null) {
      try {
        child.kill('SIGTERM')
      } catch {
        // 进程可能已退出；重复释放不应掩盖原始错误。
      }
    }
  }
}
