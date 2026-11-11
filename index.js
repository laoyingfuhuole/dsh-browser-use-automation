/**
 * 插件入口：只做组装，不在这里执行浏览器操作。代码语言是 JavaScript。
 * 阅读顺序：apply 配置插件 → src/tools.js 定义工具 → src/client.js 发送请求
 * → host/main.cjs 在单独的 Electron 进程中操作页面。
 *
 * 每个插件实例共用一个客户端和一个 Electron host，各对话独享窗口和操作队列。
 * 所有窗口共享登录存储；工具不把窗口带到前台，用户通过 Dock 主动查看除外。
 * 构造客户端不启动 Electron，卸载插件才释放全部窗口和共享进程。
 * @module dsh-browser-use-automation
 */

import { HostClient } from './src/client.js'
import { registerTools } from './src/tools.js'
import { verifyInstallation } from './src/integrity.js'

export const name = 'dsh-browser-use-automation'
// 告诉 DSH 本插件依赖哪两个服务；ctx 由框架提供，不是浏览器里的页面对象。
export const inject = ['tools', 'systemPrompt']

/**
 * DSH 加载插件时调用 apply。默认参数 {} 允许不传配置；JSDoc 中的类型只帮助
 * 编辑器提示，不会把文件变成 Java 或 TypeScript，也不负责运行时参数检查。
 * @param {import('@deepseek-ai/cordis').Context} ctx 工具注册和资源管理上下文。
 * @param {{width?: number, height?: number, screenshotDir?: string}} [config] 窗口尺寸与截图目录。
 */
export function apply(ctx, config = {}) {
  // 市场 GUI 更新也走这个加载入口；整包不一致就拒绝注册，不让新客户端配旧 host。
  verifyInstallation()
  const client = new HostClient({
    width: positiveInt(config.width, 1400),
    height: positiveInt(config.height, 900),
  })

  // effect 接收安装函数，安装函数返回卸载时执行的清理函数。这里不能立即
  // 调用 dispose，否则插件刚加载就会关闭资源；卸载时才结束进程和未完成请求。
  ctx.effect(() => () => {
    client.dispose()
  })

  // 以下是给模型看的使用说明，不是执行脚本；实际工具行为由 registerTools 定义。
  ctx.systemPrompt.section({
    name: 'tool:dsh-browser-use-automation',
    order: 150,
    text: [
      'Use the browser_use_* tools to operate the background browser. The browser is a real',
      'Chromium page in an offscreen Electron window; its window is parked outside',
      'the visible desktop, and never raised or focused by a tool call. Your work does not depend',
      'on the DSH window being in front or on any window being visible.',
      'Each conversation is automatically assigned its own window: never choose another',
      'conversation or reuse its snapshot refs. Cookies and login storage are shared, so logging',
      'out or switching accounts affects other conversations. Preserve this conversation’s window',
      'across multiple turns; never routinely close or reset it at the end of a turn or task.',
      'browser_use_close explicitly closes only this conversation’s window and rejects its',
      'queued/running operations. browser_use_reset is only for user-confirmed recovery: first',
      'warn that DOM, forms, unsaved input, and page state will be lost, then obtain the user’s',
      'confirmation before setting confirm to true. Reset rejects this conversation’s old',
      'queued/running operations, retains cookies and other windows, and creates no replacement',
      'until the next normal browser call. Never automatically close/reset on cancellation or',
      'timeout, and never automatically retry mutations: cancellation cannot roll back real page',
      'effects or guarantee termination of in-flight JavaScript. A click may still complete its',
      'press/release pair. Inspect state before deciding what to do next; a running CDP operation',
      'may still be settling, and a timed-out navigation can retain the window queue until loading',
      'actually finishes or fails, or the user explicitly requests close or confirmed reset.',
      'Start with browser_use_open (http/https), then browser_use_snapshot to get numbered',
      'elements. Click/type by that ref; take browser_use_screenshot when pixels matter. After a',
      'navigation or a submit, prefer browser_use_wait over guessing with a sleep. Use',
      'browser_use_eval for values the snapshot does not expose, and browser_use_assert before',
      'claiming a step worked. Do not paste the DSH GUI URL into the browser: it is not the target.',
    ].join(' '),
  })

  registerTools(ctx, client, config)
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}
