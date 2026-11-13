/**
 * 比较本 checkout 与明确指定的安装目录，不执行 npm、不联网、不启动或关闭 DSH。
 * 版本相同并不代表代码相同：编辑器原子保存可能替换 inode，使旧硬链接继续指向旧内容。
 * 当前发布清单使用显式文件/目录；将来改用通配符时拒绝检查，避免给出不完整的通过结论。
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const usage = 'Usage: npm run check:install -- <installed-package-directory> [--json] | --self [--json]'
const args = process.argv.slice(2)
const jsonOutput = args.includes('--json')

function manifest(root) {
  const path = resolve(root, 'package.json')
  if (!lstatSync(path).isFile()) throw new Error(`${path}: expected a regular package.json file`)
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || !Array.isArray(pkg.files)) {
    throw new Error(`${path}: name, version and explicit files list are required`)
  }
  return pkg
}

function entryPath(entry) {
  if (typeof entry !== 'string' || !entry || isAbsolute(entry) || entry.includes('\\')
    || /^[A-Za-z]:/.test(entry) || /[*!?{}[\]]/.test(entry) || entry.split('/').some(part => ['', '.', '..', '.git', 'node_modules'].includes(part))) {
    throw new Error(`Unsupported package files entry: ${JSON.stringify(entry)}; use explicit relative files/directories`)
  }
  return entry
}

function inspect(root, path) {
  // 允许整个安装目录是 npm link 创建的符号链接；目录内部的链接不跟随，
  // 防止扫描扩展到另一个包、用户资料或循环目录。遇到它就报告，不隐瞒覆盖缺口。
  const parts = path.split('/')
  for (let i = 1; i <= parts.length; i += 1) {
    const current = resolve(root, ...parts.slice(0, i))
    let stat
    try { stat = lstatSync(current) } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Internal symlink is not supported: ${current}`)
    if (i < parts.length && !stat.isDirectory()) return null
    if (i === parts.length) return stat
  }
}

function inventory(root, entries, requireEntries) {
  const paths = new Set()
  const visit = path => {
    const stat = inspect(root, path)
    if (!stat) {
      if (requireEntries) throw new Error(`Source package entry missing: ${path}`)
      return
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(resolve(root, path)).sort()) visit(`${path}/${name}`)
    } else if (stat.isFile()) paths.add(path)
    else throw new Error(`Expected file or directory: ${resolve(root, path)}`)
  }
  for (const path of entries) visit(path)
  return paths
}

function checksum(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function check(targetArgument) {
  const targetInput = resolve(targetArgument)
  const targetRoot = realpathSync(targetInput)
  if (!statSync(targetRoot).isDirectory()) throw new Error('Target must be an installed package directory')
  const source = manifest(sourceRoot)
  const target = manifest(targetRoot)
  if (source.name !== target.name) throw new Error(`Wrong target package: expected ${source.name}, found ${target.name}`)
  const entries = [...new Set(['package.json', ...source.files.map(entryPath)])]
  const expected = inventory(sourceRoot, entries, true)
  // 同时检查旧安装的声明，发现已经不应发布、却遗留在原目录的文件。
  const installedEntries = [...new Set([...entries, ...target.files.map(entryPath)])]
  const installed = inventory(targetRoot, installedEntries, false)
  const issues = []
  if (source.version !== target.version) issues.push({ kind: 'version', source: source.version, installed: target.version })
  let hardlinkedFiles = 0
  for (const path of expected) {
    const destination = inspect(targetRoot, path)
    if (!destination?.isFile()) { issues.push({ kind: 'missing-or-not-file', path }); continue }
    const sourcePath = resolve(sourceRoot, path)
    const targetPath = resolve(targetRoot, path)
    const sourceStat = statSync(sourcePath)
    if (sourceRoot !== targetRoot && sourceStat.dev === destination.dev && sourceStat.ino === destination.ino) hardlinkedFiles++
    if (checksum(sourcePath) !== checksum(targetPath)) issues.push({ kind: 'content', path })
  }
  for (const path of installed) if (!expected.has(path)) issues.push({ kind: 'unexpected', path })
  return {
    ok: issues.length === 0,
    source: { path: sourceRoot, version: source.version },
    installed: { path: targetRoot, version: target.version },
    sameDirectory: sourceRoot === targetRoot,
    directorySymlink: lstatSync(targetInput).isSymbolicLink(),
    filesChecked: expected.size, hardlinkedFiles, issues,
    scope: 'Declared package files only; does not verify loaded processes, dependencies, or installed integrity against a remote release.',
  }
}

try {
  if (args.length === 1 && args[0] === '--help') console.log(usage)
  else if (args.includes('--self')) {
    if (args.filter(arg => arg === '--self').length !== 1 || args.filter(arg => arg === '--json').length > 1 || args.some(arg => !['--self', '--json'].includes(arg))) throw new Error(usage)
    const { verifyInstallation } = await import('../src/integrity.js')
    const verified = verifyInstallation()
    if (jsonOutput) console.log(JSON.stringify({ ok: true, mode: 'installed-manifest', ...verified }, null, 2))
    else console.log(`PASS: v${verified.version}, ${verified.filesChecked} runtime files match integrity.json (${verified.manifestFiles} manifest files declared). Full package consistency is checked by npm run check:release. Running-process version is not checked.`)
  } else {
    const paths = args.filter(arg => arg !== '--json')
    if (paths.length !== 1 || paths[0].startsWith('--') || args.filter(arg => arg === '--json').length > 1) {
      throw new Error(usage)
    }
    const result = check(paths[0])
    if (jsonOutput) console.log(JSON.stringify(result, null, 2))
    else {
      console.log(`${result.ok ? 'PASS' : 'MISMATCH'}: ${result.filesChecked} package files checked`)
      console.log(`Source: ${result.source.path} (${result.source.version})`)
      console.log(`Installed: ${result.installed.path} (${result.installed.version})`)
      for (const issue of result.issues) console.log(`- ${issue.kind}: ${issue.path ?? `${issue.installed} -> ${issue.source}`}`)
      if (result.sameDirectory) console.log('The installation resolves to this checkout, not an independent copy.')
      if (result.hardlinkedFiles) console.log(`${result.hardlinkedFiles} hard-linked files: atomic saves can break links; recheck after updates.`)
      console.log('Read-only file check. Running DSH/Electron may still have old code loaded; reload after a verified update.')
    }
    process.exitCode = result.ok ? 0 : 1
  }
} catch (error) {
  if (jsonOutput) console.log(JSON.stringify({ ok: false, error: error.message }))
  else console.error(`ERROR: ${error.message}`)
  process.exitCode = error.code === 'BROWSER_USE_INSTALLATION_MISMATCH' ? 1 : 2
}
