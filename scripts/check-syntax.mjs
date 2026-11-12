import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
function collect(directory) {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? collect(path) : entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name) ? [path] : []
  })
}
const files = ['index.js', ...['src', 'host', 'scripts', 'test'].flatMap(collect)].sort()
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log(`PASS: ${files.length} JavaScript files parsed`)
