import { mountComponent } from './component.js'
export const name = 'browser-use-files'
export const inject = ['browserUse', 'tools', 'systemPrompt']
export function apply(ctx) { mountComponent(ctx, 'files') }
