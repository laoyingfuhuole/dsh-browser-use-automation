import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

test('plugin registers an independent tool surface', () => {
  const tools = []
  const sections = []
  const ctx = {
    tools: { register: definition => tools.push(definition) },
    systemPrompt: { section: section => sections.push(section) },
    effect: () => {},
    logger: { warn: () => {} },
  }
  apply(ctx, { quiet: true })
  assert.equal(tools.length, 12)
  assert.equal(new Set(tools.map(tool => tool.name)).size, tools.length)
  assert.ok(tools.every(tool => tool.name.startsWith('browser_use_')))
  assert.equal(tools.some(tool => tool.name.startsWith('dsh_browser_')), false)
  assert.equal(sections.length, 1)
  assert.match(sections[0].text, /browser_use_open/)
})
