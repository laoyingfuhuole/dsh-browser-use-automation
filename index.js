/**
 * 插件入口：只做组装，不在这里执行浏览器操作。代码语言是 JavaScript。
 * 阅读顺序：apply 提供共享核心 → 独立组件注册工具 → src/client.js 发送请求
 * → host/main.cjs 在单独的 Electron 进程中操作页面。
 *
 * 每个插件实例共用一个客户端和一个 Electron host，各对话独享窗口和操作队列。
 * 所有窗口共享登录存储；工具不把窗口带到前台，用户通过 Dock 主动查看除外。
 * 构造客户端不启动 Electron，卸载插件才释放全部窗口和共享进程。
 * @module dsh-browser-use-automation
 */

import { BrowserCore } from './src/core.js'
import { corePrompt } from './src/prompts.js'
import { verifyInstallation } from './src/integrity.js'

export const name = 'dsh-browser-use-automation'
// 核心只提供 browserUse；工具组件依赖该服务，核心关闭时由 Cordis 级联卸载。
export const inject = ['systemPrompt']
export const provide = 'browserUse'

/**
 * DSH 加载插件时调用 apply。默认参数 {} 允许不传配置；JSDoc 中的类型只帮助
 * 编辑器提示，不会把文件变成 Java 或 TypeScript，也不负责运行时参数检查。
 * @param {import('@deepseek-ai/cordis').Context} ctx 工具注册和资源管理上下文。
 * @param {{width?: number, height?: number, screenshotDir?: string}} [config] 窗口尺寸与截图目录。
 */
export function apply(ctx, config = {}) {
  // 市场 GUI 更新也走这个加载入口；整包不一致就拒绝注册，不让新客户端配旧 host。
  verifyInstallation()
  const core = new BrowserCore(config)

  // effect 接收安装函数，安装函数返回卸载时执行的清理函数。这里不能立即
  // 调用 dispose，否则插件刚加载就会关闭资源；卸载时才结束进程和未完成请求。
  ctx.effect(() => () => {
    core.dispose()
  })
  ctx.provide('browserUse', core)

  // 通用约束只出现一次，各工具组件单独拥有自己的使用提示。
  const removePrompt = ctx.systemPrompt.section({
    name: 'tool:dsh-browser-use-automation',
    order: 150,
    text: corePrompt,
  })
  ctx.effect(() => removePrompt)
}
