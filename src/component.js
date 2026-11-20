import { readFileSync } from 'node:fs'
import { registerTools } from './tools.js'
import { componentPrompts } from './prompts.js'

const groups = JSON.parse(readFileSync(new URL('./components.json', import.meta.url), 'utf8'))

export function mountComponent(ctx, group) {
  const core = ctx.get('browserUse')
  if (!core) throw new Error('browser core service is unavailable')
  const lease = core.mount(group)
  let unregister
  let removePrompt
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try { unregister?.() } finally {
      try { removePrompt?.() } finally { lease.dispose() }
    }
  }
  try {
    // 工具与提示都属于组件自己的 fiber；关闭组件不卸载共享浏览器或其他组件。
    ctx.effect(() => cleanup)
    unregister = registerTools(ctx, lease, core.config, {
      names: groups[group].tools, signal: lease.signal,
      approvalSignal: () => core.leases.get('requests')?.signal,
    })
    removePrompt = ctx.systemPrompt.section({ name: `tool:browser-use-${group}`, order: 151, text: componentPrompts[group] })
  } catch (error) {
    cleanup()
    throw error
  }
}
