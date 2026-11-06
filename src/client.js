/**
 * Parent side of the browser host.
 *
 * One child process, one authenticated loopback connection, line-delimited
 * JSON-RPC. The child is a bare Electron main process; it is spawned only on
 * the first tool call, and killed when the plugin fiber is disposed.
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
 * Find a runnable bare-Electron binary.
 *
 * Order: explicit ELECTRON_PATH, the package dependency, then the DSH profile
 * installs (this is what makes the plugin usable before `npm install` has
 * downloaded Electron). Packaged app executables are not reused: they ignore
 * a script argument.
 *
 * @returns {string}
 */
export function resolveElectronPath() {
  const override = process.env.ELECTRON_PATH
  if (typeof override === 'string' && override.length > 0 && existsSync(override)) return override

  try {
    // Resolve the package file, never execute it: electron/index.js downloads
    // the binary on require(), which would turn a missing install into a
    // network fetch at the first tool call.
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
    // electron is optional at the package level; profiles often provide it.
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
 * A lazily started browser host.
 */
export class HostClient {
  /**
   * @param {{quiet?: boolean, width?: number, height?: number}} [options]
   */
  constructor(options = {}) {
    this.options = options
    this.child = null
    this.socket = null
    this.nextId = 1
    this.pending = new Map()
    this.starting = null
    this.buffer = ''
    this.stderr = ''
  }

  /**
   * Run one host operation.
   *
   * @param {string} op
   * @param {Record<string, unknown>} [payload]
   * @param {AbortSignal} [signal]
   * @returns {Promise<unknown>}
   */
  async call(op, payload = {}, signal) {
    await this.ensureStarted()
    if (signal?.aborted) throw new Error('browser operation aborted')
    const id = this.nextId
    this.nextId += 1
    const message = { id, op, ...payload }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`browser host timed out after ${CALL_TIMEOUT_MS}ms on ${op}`))
      }, CALL_TIMEOUT_MS)
      const settle = (handler, value) => {
        clearTimeout(timer)
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        handler(value)
      }
      const onAbort = () => {
        settle(reject, new Error('browser operation aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: value => settle(resolve, value),
        reject: error => settle(reject, error),
      })
      this.socket.write(`${JSON.stringify(message)}\n`)
    })
  }

  async ensureStarted() {
    if (this.socket !== null && !this.socket.destroyed) return
    if (this.starting !== null) return this.starting
    this.starting = this.start().catch(error => {
      this.starting = null
      this.dispose()
      throw error
    })
    return this.starting
  }

  async start() {
    const electron = resolveElectronPath()
    const token = randomBytes(24).toString('hex')
    const env = { ...process.env, BROWSER_USE_TOKEN: token }
    delete env.ELECTRON_RUN_AS_NODE
    env.BROWSER_USE_WIDTH = String(this.options.width || 1400)
    env.BROWSER_USE_HEIGHT = String(this.options.height || 900)

    const child = spawn(electron, [HOST_ENTRY], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    child.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`browser host exited (code=${code}, signal=${signal})${this.stderr ? `: ${this.stderr}` : ''}`))
      }
      this.pending.clear()
      this.socket?.destroy()
      this.socket = null
    })

    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`browser host did not become ready in ${READY_TIMEOUT_MS}ms${this.stderr ? `: ${this.stderr}` : ''}`))
      }, READY_TIMEOUT_MS)
      let output = ''
      const onData = chunk => {
        output += chunk
        const newline = output.indexOf('\n')
        if (newline < 0) return
        clearTimeout(timer)
        child.stdout.off('data', onData)
        try {
          const parsed = JSON.parse(output.slice(0, newline))
          resolve(parsed.port)
        } catch (error) {
          reject(new Error(`browser host sent invalid ready line: ${output.slice(0, 200)}`))
        }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', onData)
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`browser host exited before ready (code=${code})${this.stderr ? `: ${this.stderr}` : ''}`))
      })
    })

    this.socket = connect({ host: '127.0.0.1', port })
    this.socket.setEncoding('utf8')
    this.socket.on('data', chunk => this.onData(chunk))
    this.socket.on('error', error => {
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
    })
    this.socket.on('close', () => {
      this.socket = null
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser host handshake timed out')), 5000)
      this.socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      this.socket.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })

    await this.rawCall({ id: 0, op: 'hello', token })
  }

  rawCall(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser host handshake timed out')), 5000)
      const id = message.id ?? -1
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.write(`${JSON.stringify(message)}\n`)
    })
  }

  onData(chunk) {
    this.buffer += chunk
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.buffer = ''
      this.socket?.destroy()
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
      const pending = this.pending.get(message.id)
      if (pending === undefined) continue
      this.pending.delete(message.id)
      if (message.ok === true) pending.resolve(message.result)
      else pending.reject(new Error(message.error || 'browser host error'))
    }
  }

  dispose() {
    this.starting = null
    this.socket?.destroy()
    this.socket = null
    if (this.child !== null) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        // already gone
      }
      this.child = null
    }
    for (const pending of this.pending.values()) pending.reject(new Error('browser host disposed'))
    this.pending.clear()
  }
}
