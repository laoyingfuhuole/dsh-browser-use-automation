/**
 * dsh-browser-use — a clean, background-first browser plugin for DeepSeek
 * Harness.
 *
 * The plugin owns exactly one browser process: a plain Electron window parked
 * offscreen with opacity 0, driven over CDP. Every tool call goes through the
 * same host; nothing opens a second window, raises the window, or takes focus.
 *
 * @module dsh-browser-use
 */

import { HostClient } from './src/client.js'
import { registerTools } from './src/tools.js'

export const name = 'dsh-browser-use'
export const inject = ['tools', 'systemPrompt']

/**
 * Mount the plugin.
 *
 * The browser is started lazily: loading the plugin must not start Electron,
 * so a profile that never uses a browser tool pays nothing. The host is
 * disposed with the plugin fiber.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{quiet?: boolean, width?: number, height?: number, screenshotDir?: string}} [config]
 */
export function apply(ctx, config = {}) {
  const client = new HostClient({
    quiet: config.quiet !== false,
    width: positiveInt(config.width, 1400),
    height: positiveInt(config.height, 900),
  })

  ctx.effect(() => () => {
    client.dispose()
  })

  ctx.systemPrompt.section({
    name: 'tool:browser-use',
    order: 150,
    text: [
      'Use the browser_use_* tools to operate the background browser. The browser is a real',
      'Chromium page in an offscreen Electron window; its window is transparent, parked outside',
      'the visible desktop, and never raised or focused by a tool call. Your work does not depend',
      'on the DSH window being in front or on any window being visible.',
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
