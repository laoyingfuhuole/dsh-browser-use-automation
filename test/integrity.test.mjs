import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const paths = ['package.json', 'index.js', 'src/client.js', 'src/tools.js', 'src/integrity.js', 'host/main.cjs', 'cordis.patch.yml', 'README.md', 'LICENSE']

async function fixture(t, changeManifest) {
  const root = mkdtempSync(join(tmpdir(), 'browser-use-integrity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {}
  for (const path of paths) {
    const content = path === 'package.json'
      ? JSON.stringify({ name: 'dsh-browser-use-automation', version: '0.3.5', type: 'module' })
      : path === 'src/integrity.js'
        ? readFileSync(new URL('../src/integrity.js', import.meta.url), 'utf8')
        : `fixture ${path}\n`
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
    files[path] = createHash('sha256').update(content).digest('hex')
  }
  const manifest = { schema: 1, name: 'dsh-browser-use-automation', version: '0.3.5', files }
  changeManifest?.(manifest)
  writeFileSync(join(root, 'integrity.json'), JSON.stringify(manifest))
  const module = await import(pathToFileURL(join(root, 'src/integrity.js')).href + `?fixture=${randomUUID()}`)
  return { root, module }
}

const mismatch = error => error.code === 'BROWSER_USE_INSTALLATION_MISMATCH'

test('complete package verifies independently of the checkout', async t => {
  const h = await fixture(t)
  const result = h.module.verifyInstallation()
  assert.equal(result.version, '0.3.5')
  assert.equal(result.filesChecked, 7)
  assert.equal(result.manifestFiles, 9)
})

test('modified or missing runtime files are rejected', async t => {
  for (const missing of [false, true]) {
    const h = await fixture(t)
    if (missing) unlinkSync(join(h.root, 'host/main.cjs'))
    else writeFileSync(join(h.root, 'host/main.cjs'), 'modified')
    assert.throws(() => h.module.verifyInstallation(), mismatch)
  }
})

test('non-runtime documentation may change while runtime code changes still fail', async t => {
  const h = await fixture(t)
  writeFileSync(join(h.root, 'README.md'), 'documentation changed')
  assert.doesNotThrow(() => h.module.verifyInstallation())
  writeFileSync(join(h.root, 'src/client.js'), 'runtime code changed')
  assert.throws(() => h.module.verifyInstallation(), mismatch)
})

test('changing manifest after module load requires reload', async t => {
  const h = await fixture(t)
  writeFileSync(join(h.root, 'integrity.json'), '{}')
  assert.throws(() => h.module.verifyInstallation(), error => mismatch(error) && /reload required/.test(error.message))
})

for (const [name, mutate] of [
  ['required runtime omitted', value => { delete value.files['host/main.cjs'] }],
  ['unsupported schema', value => { value.schema = 99 }],
  ['invalid checksum', value => { value.files['index.js'] = 'not-a-hash' }],
  ['parent traversal', value => { value.files['../outside'] = 'a'.repeat(64) }],
  ['version mismatch', value => { value.version = '0.3.6' }],
]) {
  test(`invalid installation rejects ${name}`, async t => {
    const h = await fixture(t, mutate)
    assert.throws(() => h.module.verifyInstallation(), mismatch)
  })
}
