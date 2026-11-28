'use strict'

// Runs only as a test entry point. The application gets the same packed host and local toolbar as an installation.
const { app } = require('electron')
const { join } = require('node:path')
const assert = require('node:assert/strict')
const { setTimeout: delay } = require('node:timers/promises')

const [directory, origin] = process.argv.slice(2)
function fail(error) {
  console.error(error.stack || error)
  app.exit(1)
}
process.on('uncaughtException', fail)

async function until(check, label) {
  for (let i = 0; i < 160; i++) {
    if (await check()) return
    await delay(50)
  }
  throw new Error('toolbar timed out: ' + label)
}

// Only one test command is in flight. The parent sends it through the normal authenticated host socket.
let sequence = 0
function rpc(op, payload = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    process.once('message', reply => {
      if (reply.sequence !== id || !reply.ok) reject(new Error(reply.error || 'unexpected test RPC response'))
      else resolve(reply.result)
    })
    process.send({ sequence: id, op, payload })
  })
}

async function run(win) {
  const shell = win.webContents
  const js = expression => shell.executeJavaScript(expression)
  const click = selector => js('document.querySelector(' + JSON.stringify(selector) + ').click()')
  const input = async url => {
    await js("document.querySelector('#address').focus(); document.querySelector('#address').select()")
    await shell.debugger.sendCommand('Input.insertText', { text: url })
    await shell.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await shell.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  const count = n => js("document.querySelectorAll('.tab').length === " + n)
  await until(() => count(1), 'initial tab')
  shell.debugger.attach('1.3')
  const list = () => js("browserToolbar.action('list')")
  const active = async () => {
    const state = await list()
    return state.tabs.find(tab => tab.id === state.activeTabId)
  }
  await input(origin + 'forms')
  await until(async () => (await active()).title === 'Form controls', 'address + Enter')
  assert.equal(await js("document.querySelector('#address').value"), origin + 'forms')
  await click('#new')
  await until(() => count(2), 'new tab')
  await input(origin)
  await until(async () => (await active()).title === 'Packed smoke', 'second URL')
  await click('.tab:first-child button')
  await until(async () => (await active()).title === 'Form controls', 'select')
  await click('#back')
  await until(async () => (await active()).url === 'about:blank', 'back')
  await click('#forward')
  await until(async () => (await active()).title === 'Form controls', 'forward')
  const page = win.contentView.children.at(-1).webContents
  await page.executeJavaScript("window.reloadMarker = 'before'")
  await click('#reload')
  await until(async () => (await page.executeJavaScript('window.reloadMarker')) === undefined, 'reload')
  await click('.tab.selected button:last-child')
  await until(() => count(1), 'close')
  assert.equal((await active()).title, 'Packed smoke')
  assert.equal(win.isFocused(), false)
  await input(origin + 'retry')
  await until(() => js("!document.querySelector('#error').hidden"), 'HTTP error feedback')
  await click('button[type=submit]')
  await until(async () => (await active()).title === 'Recovered', 'retry same address')
  await until(() => js("document.querySelector('#error').hidden"), 'clear error on retry')

  if (process.env.DSH_TEST_FOREGROUND === '1') {
    await rpc('windowShow')
    await until(() => win.isFocused(), 'explicit show')
    const current = win.contentView.children.at(-1).webContents
    current.focus()
    const chord = (contents, key) => {
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control']
      contents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers })
      contents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers })
    }
    chord(current, 'L')
    await until(() => js("document.hasFocus() && document.activeElement.id === 'address'"), 'address shortcut')
    chord(shell, 'T')
    await until(() => count(2), 'new tab shortcut')
    const old = win.contentView.children.at(-1).webContents
    old.focus()
    const state = await list()
    const hiddenId = state.activeTabId
    await rpc('tabs', { action: 'select', tabId: state.tabs[0].id })
    await until(() => current.isFocused(), 'tool select moved native page focus')
    await old.executeJavaScript("document.body.innerHTML = '<input id=inactive>'")
    const snapshot = await rpc('snapshot', { tabId: hiddenId })
    const ref = snapshot.elements.find(item => item.selector === '#inactive').ref
    await rpc('click', { tabId: hiddenId, ref })
    await rpc('type', { tabId: hiddenId, ref, text: 'background', mode: 'fast' })
    assert.equal(await old.executeJavaScript('inactive.value'), 'background')
    assert.equal(current.isFocused(), true, 'background input stole keyboard focus from selected tab')
    chord(current, 'W')
    await until(() => count(1), 'close shortcut')
  }
  console.log('PASS: packed Electron toolbar: URL + Enter, tab buttons, back, forward and reload' +
    (process.env.DSH_TEST_FOREGROUND === '1' ? ', foreground shortcuts and keyboard focus' : ''))
  app.exit(0)
}

app.once('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => run(win).catch(fail))
})
require(join(directory, 'host/main.cjs'))
