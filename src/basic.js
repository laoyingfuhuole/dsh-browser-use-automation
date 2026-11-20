import { mountComponent } from './component.js'
export const name = 'browser-use-basic'
export const inject = ['browserUse', 'tools', 'systemPrompt']
export function apply(ctx) { mountComponent(ctx, 'basic') }
