import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function fixture() {
  const calls = []
  let response = { accepted: false }
  const page = vm.createContext({ DOMException })
  vm.runInContext('globalThis.showOpenFilePicker = globalThis.showSaveFilePicker = globalThis.showDirectoryPicker = () => { throw new Error("native picker must not be called") }', page)
  const bridge = {
    exposeInMainWorld(name, callback) { page[name] = callback },
    executeInMainWorld({ func }) { return vm.runInContext(`(${func.toString()})()`, page) },
  }
  vm.runInNewContext(readFileSync(new URL('../host/native-preload.cjs', import.meta.url), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron')
      return { contextBridge: bridge, ipcRenderer: { sendSync(channel, payload) {
        assert.equal(channel, 'dsh-browser-native-ui')
        calls.push(payload)
        return response
      } } }
    },
  })
  return { calls, evaluate: code => vm.runInContext(code, page), answer: value => { response = value } }
}

test('preload preserves synchronous confirm, prompt and alert outcomes without exposing IPC', () => {
  const h = fixture()
  assert.equal(h.evaluate('confirm("continue")'), false)
  assert.equal(h.evaluate('prompt("text", "default")'), null)
  h.answer({ accepted: true, value: 'approved text' })
  assert.equal(h.evaluate('confirm("continue")'), true)
  assert.equal(h.evaluate('prompt("text", "default")'), 'approved text')
  assert.equal(h.evaluate('alert("notice")'), undefined)
  assert.equal(h.calls.at(-1).kind, 'alert')
  assert.equal(h.evaluate('typeof require'), 'undefined')
  assert.equal(h.evaluate('typeof ipcRenderer'), 'undefined')
  assert.equal(h.evaluate('typeof process'), 'undefined')
})

test('preload intercepts print and explicitly rejects all File System Access pickers', async () => {
  const h = fixture()
  assert.equal(h.evaluate('print()'), undefined)
  assert.equal(h.calls[0].kind, 'print')
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    await assert.rejects(h.evaluate(`${name}()`), error => error.name === 'NotAllowedError')
    assert.equal(h.calls.at(-1).kind, 'unsupported')
    assert.match(h.calls.at(-1).message, new RegExp(name))
  }
  assert.equal(h.evaluate('Object.getOwnPropertyDescriptor(globalThis,"print").writable'), false)
})
