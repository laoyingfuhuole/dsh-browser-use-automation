/**
 * 发布前显式生成整包 SHA-256 清单；市场安装时无需 npm prepare/postinstall。
 * --check 只验证现有清单；发布前主动检查，不注册 prepare/prepack/postinstall，
 * 避免市场安装时触发额外构建审批或依赖下载。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = resolve(root, 'integrity.json')
const args = process.argv.slice(2)
try {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: node scripts/prepare-release.mjs [--check]')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'dsh-browser-use' || !/^\d+\.\d+\.\d+$/.test(pkg.version) || !Array.isArray(pkg.files)) throw new Error('Expected numeric release version and explicit package.files list')
  const paths = new Set(['package.json'])
  function visit(path) {
    if (typeof path !== 'string' || path.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part))
      || path.split('/').some(part => ['.', '..', 'node_modules', '.git'].includes(part))) throw new Error(`Unsupported release path: ${path}`)
    if (path === 'integrity.json') return
    // 每个父目录也校验，不能通过中间符号链接把包外文件意外打包。
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = lstatSync(resolve(root, ...parts.slice(0, i)))
      if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error(`Unsupported release directory: ${path}`)
    }
    const stat = lstatSync(resolve(root, path))
    if (stat.isSymbolicLink()) throw new Error(`Release symlink not supported: ${path}`)
    if (stat.isDirectory()) for (const name of readdirSync(resolve(root, path)).sort()) visit(`${path}/${name}`)
    else if (stat.isFile()) paths.add(path)
    else throw new Error(`Unsupported release file: ${path}`)
  }
  for (const path of pkg.files) visit(path)
  const files = Object.fromEntries([...paths].sort().map(path => [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]))
  const content = JSON.stringify({ schema: 1, name: pkg.name, version: pkg.version, files }, null, 2) + '\n'
  if (args[0] === '--check') {
    if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== content) throw new Error('Release manifest is missing or stale. Run npm run prepare:release, review it, then retry.')
    console.log(`PASS: v${pkg.version}, ${paths.size} release files verified`)
  } else {
    const temporary = resolve(root, `.integrity-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, content, { flag: 'wx' })
      renameSync(temporary, manifestPath)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
    console.log(`Prepared v${pkg.version}: ${paths.size} files. Commit integrity.json with its source; no tag or release was created.`)
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`)
  process.exitCode = 1
}
