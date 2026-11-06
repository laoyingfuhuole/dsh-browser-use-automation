/**
 * Model-facing tools. Every tool talks to the same host client; there is no
 * second window, no page-presentation barrier, and no focus call in any path.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
let defineTool
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch (error) {
  // The peer is provided by DSH. The test runner uses an identity shim so the
  // package's own tests do not need a full DSH installation.
  if (process.env.DSH_BROWSER_USE_TEST !== '1') throw error
  defineTool = definition => definition
}

const ELEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'number', required: true, description: 'Stable within the latest snapshot.' },
    kind: { type: 'string', required: true },
    label: { type: 'string', required: true },
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    selector: { type: 'string' },
  },
}

const SNAPSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', required: true },
    title: { type: 'string' },
    truncated: { type: 'boolean' },
    elements: { type: 'array', required: true, items: ELEMENT_SCHEMA },
  },
}

/**
 * Render a snapshot as compact text: the format the model reads, not JSON.
 *
 * @param {{url: string, title?: string, elements: Array<{ref: number, kind: string, label: string, selector?: string}>, truncated?: boolean}} value
 * @returns {string}
 */
export function formatSnapshot(value) {
  const header = `URL: ${value.url}${value.title ? `\nTitle: ${value.title}` : ''}`
  const lines = value.elements.map(element => {
    const selector = element.selector ? ` {${element.selector}}` : ''
    return `[${element.ref}] ${element.kind} "${element.label}"${selector}`
  })
  const body = lines.length > 0 ? lines.join('\n') : '(no interactive elements)'
  return `${header}\n\n${body}${value.truncated === true ? '\n(truncated at 150 elements)' : ''}`
}

function screenshotDirectory(config) {
  if (typeof config.screenshotDir === 'string' && config.screenshotDir.length > 0) {
    return config.screenshotDir
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'browser-use', 'screenshots')
}

/**
 * Register every tool on the context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./client.js').HostClient} client
 * @param {{screenshotDir?: string}} config
 */
export function registerTools(ctx, client, config = {}) {
  const register = definition => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-browser-use: could not register ${definition.name} (${String(error)})`)
    }
  }

  register(defineTool({
    name: 'browser_use_open',
    description: 'Open an http(s) URL in the background browser and return the resulting snapshot. This replaces the current tab; it does not open a visible window and does not focus anything. Use the returned element refs with browser_use_click and browser_use_type.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http(s) URL to open.' },
    },
    output: {
      schema: SNAPSHOT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return client.call('navigate', { url: args.url }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_snapshot',
    description: 'Return the current page as numbered interactive elements (buttons, links, inputs). Refs are valid only for this snapshot; take a new one after the page changes.',
    parameters: {},
    output: {
      schema: SNAPSHOT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return client.call('snapshot', {}, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_click',
    description: 'Click the interactive element with the given ref from the latest browser_use_snapshot. The click is a real CDP mouse event at the element centre; it never raises or focuses the Electron window.',
    parameters: {
      ref: { type: 'number', required: true, description: 'Ref from the latest snapshot.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          clicked: { type: 'boolean', required: true },
          ref: { type: 'number', required: true },
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Clicked [${value.ref}] at (${value.x}, ${value.y}).` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return client.call('click', { ref: args.ref }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_type',
    description: 'Focus the element with the given ref and insert text with CDP Input.insertText. Use this for search boxes and forms; React/Vue controlled inputs receive a real input event.',
    parameters: {
      ref: { type: 'number', required: true, description: 'Ref from the latest snapshot.' },
      text: { type: 'string', required: true, description: 'Text to insert.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { typed: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Inserted ${value.typed} characters.` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return client.call('type', { ref: args.ref, text: args.text }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_insert_text',
    description: 'Insert text into the currently focused editable element with CDP Input.insertText, without needing a snapshot ref. Use it for rich-text editors and page bodies; focus the element first with browser_use_eval if it has no ref.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to insert at the current selection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { typed: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Inserted ${value.typed} characters at the current selection.` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return client.call('insertText', { text: args.text }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_screenshot',
    description: 'Capture the current viewport as a JPEG and save it under the DSH state directory. Returns the file path; use a vision-capable read tool on that path when pixels matter.',
    parameters: {
      fullPage: { type: 'boolean', description: 'Reserved; the host currently captures the viewport.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          mime: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Screenshot: ${value.path} (${value.bytes} bytes)` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const shot = await client.call('screenshot', {}, exec.signal)
      const directory = screenshotDirectory(config)
      mkdirSync(directory, { recursive: true })
      const path = join(directory, `browser-use-${Date.now()}.jpg`)
      const bytes = Buffer.from(shot.base64, 'base64')
      writeFileSync(path, bytes)
      return { path, mime: 'image/jpeg', bytes: bytes.length }
    },
  }))

  register(defineTool({
    name: 'browser_use_eval',
    description: 'Evaluate a JavaScript expression in the page and return its value as a string. Use for values a snapshot cannot express; do not use it to drive the page when a ref-based tool exists.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JavaScript expression evaluated in the page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          value: { type: 'string' },
          exception: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `Result: ${String(value.value ?? '').slice(0, 50_000)}` : `Exception: ${value.exception ?? 'unknown'}`,
      }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return client.call('eval', { expression: args.expression }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_wait',
    description: 'Wait until the page is loaded and an optional URL prefix, CSS selector, or body text is present. Returns ready=false with a reason on timeout; a miss is not an error.',
    parameters: {
      url: { type: 'string', description: 'URL prefix that must match.' },
      selector: { type: 'string', description: 'CSS selector that must exist.' },
      text: { type: 'string', description: 'Text that must appear in the body.' },
      timeoutMs: { type: 'number', description: 'Maximum wait in ms (default 10000, max 30000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ready: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.ready ? 'Page ready.' : `Not ready: ${value.reason}` }],
    },
    timeoutMs: 35_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return client.call('wait', {
        ...typeof args.url === 'string' ? { url: args.url } : {},
        ...typeof args.selector === 'string' ? { selector: args.selector } : {},
        ...typeof args.text === 'string' ? { text: args.text } : {},
        ...typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {},
      }, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_assert',
    description: 'Assert that a selector exists, body text is present, the URL contains a string, or a JavaScript expression is truthy. Use this before claiming a click or submit worked.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector that must match an element.' },
      text: { type: 'string', description: 'Text that must appear in the body.' },
      url: { type: 'string', description: 'Substring the current URL must contain.' },
      js: { type: 'string', description: 'JavaScript expression that must be truthy.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pass: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.pass ? `PASS: ${value.detail}` : `FAIL: ${value.detail}` }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const checks = []
      if (typeof args.selector === 'string') checks.push(`!!document.querySelector(${JSON.stringify(args.selector)})`)
      if (typeof args.text === 'string') checks.push(`(document.body ? document.body.innerText : '').includes(${JSON.stringify(args.text)})`)
      if (typeof args.url === 'string') checks.push(`location.href.includes(${JSON.stringify(args.url)})`)
      if (typeof args.js === 'string') checks.push(`Boolean(${args.js})`)
      const expression = checks.length > 0 ? `(${checks.join(' && ')})` : 'true'
      const result = await client.call('eval', { expression }, exec.signal)
      return {
        pass: result.ok === true && result.value === 'true',
        detail: result.ok === true ? String(result.value) : String(result.exception ?? 'evaluation failed'),
      }
    },
  }))

  register(defineTool({
    name: 'browser_use_state',
    description: 'Read the current URL, title, document readyState and the first 400 characters of visible text. A cheap orientation check before a full snapshot.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          readyState: { type: 'string', required: true },
          bodyText: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.url}\n${value.title}\n${value.readyState}\n\n${value.bodyText}`,
      }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return client.call('state', {}, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_back',
    description: 'Go back in the page history and return the resulting snapshot.',
    parameters: {},
    output: {
      schema: SNAPSHOT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      return client.call('back', {}, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_reload',
    description: 'Reload the current page and return the resulting snapshot.',
    parameters: {},
    output: {
      schema: SNAPSHOT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      return client.call('reload', {}, exec.signal)
    },
  }))

  register(defineTool({
    name: 'browser_use_close',
    description: 'Close the background browser host. The next browser tool starts a fresh one.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { closed: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.closed ? 'Browser closed.' : 'Browser close failed.' }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      return client.call('close', {}, exec.signal)
    },
  }))
}
