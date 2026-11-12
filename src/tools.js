/**
 * 给模型使用的浏览器工具：本文件把工具参数转换成 client.call() 请求，
 * 真正的浏览器操作由共享 host 完成；不同会话使用各自的后台窗口，不抢占桌面焦点。
 *
 * 理解工具定义时，可以分清三层：
 * - parameters / output.schema 描述输入、输出的数据形状，交给工具框架校验。
 *   本 SDK 用每个字段上的 required: true 标记必填；这不是在执行浏览器操作。
 * - execute 接收参数，调用 host，返回结构化数据；必要的业务约束仍要自行检查。
 * - output.render 把返回值变成模型阅读的消息，不应在渲染时再次操作页面。
 *
 * 这里的文件读写、Buffer 等属于宿主侧 Node.js；传给 eval 的 expression 才在
 * 网页中执行，使用 document / location。两边不是同一作用域，不能共享局部变量。
 * 页面脚本也不等同于运行本文件中的 Node.js 代码。
 *
 * 每个请求都传入 exec.signal；取消/超时立即结束等待，并尽力通知 host 跳过
 * 排队请求，或在当前 CDP 调用结束后停止后续步骤；点击的按下/松开仍会配对清理。
 * 已产生的页面效果不能回滚，已运行的页面脚本也不保证立即停止；旧操作真正
 * 结束前窗口队列仍可能等待，不会因此自动关闭、重置窗口或重试操作。
 * timeoutMs 是工具层预算；例如 wait 另有页面等待时限，不应把二者混为一谈。
 * isConcurrencySafe 表示是否允许并发调度，不是锁，也不保证页面状态始终不变。
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
 * 把结构化快照变成紧凑文本，而不是 JSON；这里只展示，不执行文本中的内容。
 * map() 生成每个元素的一行，join() 用换行符连接。ref 是最近一次快照里的编号，
 * 不是永久元素 ID；页面变化后应重新取快照，再使用其中的 ref 点击或输入。
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

// 只有快照输出完全重复，提取这一小块即可；每次返回新的 output 对象，
// 工具名称、参数、超时与 execute 仍留在各自定义中，不隐藏实际行为。
function snapshotOutput() {
  return {
    schema: SNAPSHOT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
  }
}

function screenshotDirectory(config) {
  // 优先使用显式目录；否则依次选择 DSH_HOME 或用户主目录下的 .dsh。
  // screenshotDir 原样使用，若是相对路径，Node.js 会相对于当前工作目录解析。
  if (typeof config.screenshotDir === 'string' && config.screenshotDir.length > 0) {
    return config.screenshotDir
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 包名已迁移；保留旧截图目录，避免用户的历史路径和外部引用失效。
  return join(home, 'browser-use', 'screenshots')
}

/**
 * 把工具逐个注册到框架上下文。具体定义保留在调用处，便于对照参数、超时与行为。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./client.js').HostClient} client
 * @param {{screenshotDir?: string}} config
 */
export function registerTools(ctx, client, config = {}) {
  // DSH 的 exec.agent.id 是可信的稳定会话 ID，不能从模型参数中选窗口。
  // trim() 仅校验空白，不改写 ID；同一个 host 按会话分别管理窗口。
  const call = (op, payload, exec) => {
    const conversationId = exec?.agent?.id
    if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
      throw new TypeError('dsh-browser-use-automation: exec.agent.id must be a non-blank string to route browser tools.')
    }
    return client.call(op, { ...payload, conversationId }, exec.signal)
  }

  const register = definition => {
    try {
      ctx.tools.register(definition)
    } catch (error) {
      // 不能只记录警告后继续，否则插件看似加载成功，实际上却缺少工具。
      // cause 保留原始异常，消息补充工具名；抛错会立即中断后续注册。
      // 不假设 ctx 存在撤销 API：此处不承诺回滚已经成功注册的工具。
      throw new Error(`dsh-browser-use-automation: could not register ${definition.name} (${String(error)})`, { cause: error })
    }
  }

  register(defineTool({
    name: 'browser_use_open',
    description: 'Open an http(s) URL in this conversation’s background browser window and return the resulting snapshot. This replaces the current page in this conversation only; other conversation windows are unaffected. It does not open a visible window or focus anything. Use the returned element refs with browser_use_click and browser_use_type.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http(s) URL to open.' },
    },
    output: snapshotOutput(),
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return call('navigate', { url: args.url }, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_snapshot',
    description: 'Return the current page as numbered interactive elements (buttons, links, inputs). Refs are valid only for this snapshot; take a new one after the page changes.',
    parameters: {},
    output: snapshotOutput(),
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return call('snapshot', {}, exec)
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
      return call('click', { ref: args.ref }, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_hover',
    description: 'Move the page pointer to the centre of an element from this conversation’s latest snapshot, without clicking or focusing the native window. Validates the ref, scrolls the target into view and checks visibility/occlusion. Reports mouse-move dispatch only, not that a menu or tooltip appeared. Use browser_use_wait and take a new snapshot to inspect revealed controls. No automatic wait, click or ref refresh; site hover handlers may still have effects.',
    parameters: {
      ref: { type: 'number', required: true, description: 'Ref from this conversation’s latest browser_use_snapshot.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dispatched: { type: 'boolean', required: true },
          ref: { type: 'number', required: true },
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Pointer moved to [${value.ref}] at (${value.x}, ${value.y}) without clicking. Dispatch only: inspect the page to confirm a menu or tooltip appeared, then take a new snapshot for revealed controls.`,
      }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return call('hover', { ref: args.ref }, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_scroll',
    description: 'Dispatch a real CDP mouse-wheel event in this conversation’s background page. Positive deltaY scrolls down; negative scrolls up. Default is 600 CSS pixels at the viewport centre. Coordinates are viewport CSS pixels; this does not read the page or claim that lazy-loaded content has finished updating. Use browser_use_read or browser_use_wait to inspect the result.',
    parameters: {
      deltaY: { type: 'number', description: 'Optional vertical wheel movement, integer from -10000 to 10000. Defaults to 600.' },
      deltaX: { type: 'number', description: 'Optional horizontal wheel movement, integer from -10000 to 10000. Defaults to 0.' },
      x: { type: 'number', description: 'Optional page CSS-viewport x coordinate, integer from zero to one pixel below the viewport width. Defaults to the viewport centre.' },
      y: { type: 'number', description: 'Optional page CSS-viewport y coordinate, integer from zero to one pixel below the viewport height. Defaults to the viewport centre.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dispatched: { type: 'boolean', required: true },
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
          deltaX: { type: 'number', required: true },
          deltaY: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Wheel event sent at (${value.x}, ${value.y}): deltaX=${value.deltaX}, deltaY=${value.deltaY}. This confirms dispatch only, not that the page finished scrolling.`,
      }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return call('scroll', {
        ...args.deltaY !== undefined ? { deltaY: args.deltaY } : {},
        ...args.deltaX !== undefined ? { deltaX: args.deltaX } : {},
        ...args.x !== undefined ? { x: args.x } : {},
        ...args.y !== undefined ? { y: args.y } : {},
      }, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_key',
    description: 'Press one supported key or modifier chord in this conversation’s background page using CDP keyboard events. Supported keys: Enter, Tab, Escape, Backspace, Delete, Insert, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, Space, F1-F12. Modifiers: Control/Ctrl, Alt, Shift, Meta/Cmd/Command, or Mod (Command on macOS, Control elsewhere). Example: Enter or Mod+ArrowLeft. It attempts to release every dispatched key, including after cancellation, and reports release errors. Enter can submit forms; shortcuts may trigger browser/page actions. This does not type text or inspect the clipboard.',
    parameters: {
      key: { type: 'string', required: true, description: 'A supported key name, optionally prefixed by modifier names joined with +, e.g. Enter, Shift+Tab, Mod+ArrowLeft.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pressed: { type: 'string', required: true },
          key: { type: 'string', required: true },
          modifiers: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Key event sent: ${value.modifiers.length ? `${value.modifiers.join('+')}+` : ''}${value.key}. This confirms dispatch only, not that the page completed the action.`,
      }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return call('key', { key: args.key }, exec)
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
      return call('type', { ref: args.ref, text: args.text }, exec)
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
      return call('insertText', { text: args.text }, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_screenshot',
    description: 'Capture this conversation’s current viewport as a JPEG and save it under the DSH state directory. Returns the file path; use a vision-capable read tool on that path when pixels matter.',
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
      // fullPage 保留为兼容参数；host 目前只截取视口，因此不把它传成新能力。
      const shot = await call('screenshot', {}, exec)
      const directory = screenshotDirectory(config)
      // recursive 允许逐层创建目录，已有目录不会因此报错。随机后缀避免并发截图重名；
      // 文件名不包含会话 ID，避免在路径中泄露会话信息。
      mkdirSync(directory, { recursive: true })
      const path = join(directory, `dsh-browser-use-automation-${Date.now()}-${randomUUID()}.jpg`)
      // host 经消息通道传回的是 base64 文本；必须先解码成 Buffer 字节再保存，
      // 不能把 base64 字符串直接写成 .jpg。bytes 是实际二进制大小，不是文本长度。
      // 同步文件写入不接受 AbortSignal；写入失败会抛错，不会返回一个虚假的成功路径。
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
      return call('eval', { expression: args.expression }, exec)
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
      // 对象展开 ... 只复制类型正确的可选字段；默认等待时间及上限由 host 处理。
      // wait 与 assert 不同：没有额外条件仍可等待页面加载，不应套用断言的非空限制。
      return call('wait', {
        ...typeof args.url === 'string' ? { url: args.url } : {},
        ...typeof args.selector === 'string' ? { selector: args.selector } : {},
        ...typeof args.text === 'string' ? { text: args.text } : {},
        ...typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {},
      }, exec)
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
      // trim() 只用于识别空白条件，不修改原字符串：正文或 URL 中的空格可能有意义。
      // schema 负责字段类型；这里补充跨字段约束，防止没有检查项却报告成功。
      const hasCondition = value => typeof value === 'string' && value.trim().length > 0
      // 这些字符串会拼入页面 JavaScript。JSON.stringify 把普通输入转为字符串字面量，
      // 正确转义引号、换行和反斜杠，避免文本被误当成代码；它不校验 CSS 选择器。
      if (hasCondition(args.selector)) checks.push(`!!document.querySelector(${JSON.stringify(args.selector)})`)
      if (hasCondition(args.text)) checks.push(`(document.body ? document.body.innerText : '').includes(${JSON.stringify(args.text)})`)
      if (hasCondition(args.url)) checks.push(`location.href.includes(${JSON.stringify(args.url)})`)
      // js 与上面的普通文本不同，本来就是要执行的页面表达式，不应 JSON.stringify。
      // 多项条件保持 &&（AND）语义：全部通过才成功，前项为假时后项会短路、不执行。
      if (hasCondition(args.js)) checks.push(`Boolean(${args.js})`)
      if (checks.length === 0) {
        throw new TypeError('browser_use_assert requires at least one non-empty selector, text, url, or js condition.')
      }
      const expression = `(${checks.join(' && ')})`
      const result = await call('eval', { expression }, exec)
      // host 把求值结果编码为字符串，因此比较 'true' 而不是布尔值 true。
      // 非法选择器或表达式等页面求值异常仍按既有约定返回 pass: false 与异常详情。
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
      return call('state', {}, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_read',
    description: 'Read rendered text from this conversation’s top-level page or the first matching CSS region, without changing snapshot refs. Includes off-viewport rendered text, not just the screen. This is plain page text, not article extraction; no iframe, shadow-root traversal, canvas or OCR. Hidden roots return empty text. Default 6000 UTF-16 code units, maximum 24000; truncation is explicit and never splits a surrogate pair.',
    parameters: {
      selector: { type: 'string', description: 'Optional CSS selector for the first HTML region to read; defaults to body.' },
      maxChars: { type: 'number', description: 'Integer output budget in UTF-16 code units, from 1 to 24000 (default 6000).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          text: { type: 'string', required: true },
          totalChars: { type: 'number', required: true },
          returnedChars: { type: 'number', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `URL: ${value.url}\nTitle: ${value.title}\nScope: top-level rendered text only; no frame traversal, OCR or article filtering.\nCharacters (UTF-16): ${value.returnedChars}/${value.totalChars}${value.truncated ? ' (truncated; select a narrower region or increase maxChars up to 24000)' : ''}\n\n${value.text || '(no rendered text in the selected region)'}`,
      }],
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return call('read', {
        ...args.selector !== undefined ? { selector: args.selector } : {},
        ...args.maxChars !== undefined ? { maxChars: args.maxChars } : {},
      }, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_back',
    description: 'Go back in the page history and return the resulting snapshot.',
    parameters: {},
    output: snapshotOutput(),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      return call('back', {}, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_reload',
    description: 'Reload the current page and return the resulting snapshot.',
    parameters: {},
    output: snapshotOutput(),
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      return call('reload', {}, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_reset',
    description: 'Explicit, user-confirmed recovery only: urgently destroy this conversation’s current browser window and reject its queued/running operations, bypassing its operation queue. All DOM, forms, unsaved input, and page state are lost. Cookies, shared login storage, and other conversation windows are retained. Warn the user about state loss and obtain confirmation before setting confirm to true. No replacement is created until the next normal browser call. Never use for routine end-of-turn cleanup, automatic recovery, or automatic retry of mutations.',
    parameters: {
      confirm: { type: 'boolean', required: true, description: 'Must be true only after the user confirms recovery and understands the loss of DOM, forms, and page state.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { reset: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Browser reset: ${value.reset}.` }],
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // schema 的布尔类型声明不是用户同意；运行时必须严格等于 true 才能派发。
      // reset 只销毁此对话窗口，不自动创建替代窗口，也不重试已产生效果的操作。
      if (args?.confirm !== true) throw new TypeError('browser_use_reset requires confirm === true after a state-loss warning and user confirmation.')
      return call('reset', {}, exec)
    },
  }))

  register(defineTool({
    name: 'browser_use_close',
    description: 'Explicitly close only this conversation’s background browser window, urgently bypassing its operation queue and rejecting its queued/running operations. The shared host, cookies, and other conversation windows stay alive; the next normal browser call creates a fresh window for this conversation. Never close as routine end-of-turn cleanup; preserve the window across turns.',
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
      return call('close', {}, exec)
    },
  }))
}
