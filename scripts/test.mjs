import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? discover(path) : entry.isFile() && entry.name.endsWith('.test.mjs') ? [path] : []
  }).sort()
}
const files = discover(join(root, 'test'))
if (files.length === 0) throw new Error('No test files found')
const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', '--test-timeout=10000', ...process.argv.slice(2), ...files], {
  cwd: root, stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
