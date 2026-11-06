import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

test('package metadata is a DSH bundle', () => {
  assert.equal(pkg.name, 'dsh-browser-use')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(pkg.files.includes('index.js'))
  assert.ok(pkg.files.includes('host'))
  assert.ok(pkg.files.includes('cordis.patch.yml'))
})

test('bundle patch has one independent row', () => {
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-browser-use/)
  assert.match(patch, /name: dsh-browser-use/)
  assert.equal(patch.includes('dsh-builtin-browser'), false)
})
