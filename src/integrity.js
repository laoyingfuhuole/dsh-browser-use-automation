/**
 * dshmarket 负责下载、安装及重载；插件只核对本次加载的整包文件，绝不自行更新。
 * 清单随 GitHub 源码/发布包一起提供，安装时即使禁用 lifecycle scripts 也可校验。
 * 这能发现缺文件和新旧版本混装，但不是来源签名，不能证明远端作者身份。
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const manifestUrl = new URL('integrity.json', root)
// 固定当前模块加载时的清单；同路径被市场换包后，旧客户端不能再启动新版 host。
let loadedManifest
let manifestError
try { loadedManifest = readFileSync(manifestUrl, 'utf8') } catch (error) { manifestError = error }

function invalid(detail) {
  const error = new Error(`dsh-parallel-browser: installation verification failed (${detail}). Reinstall the complete package from the correct dshmarket repository entry, then reload DSH. Do not patch individual runtime files.`)
  error.code = 'BROWSER_USE_INSTALLATION_MISMATCH'
  return error
}

export function verifyInstallation() {
  try {
    if (manifestError) throw manifestError
    if (readFileSync(manifestUrl, 'utf8') !== loadedManifest) throw new Error('package changed after this plugin instance loaded; reload required')
    const manifest = JSON.parse(loadedManifest)
    if (manifest.schema !== 1 || manifest.name !== 'dsh-parallel-browser'
      || typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)
      || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
      throw new Error('invalid integrity manifest')
    }
    for (const required of ['package.json', 'index.js', 'src/client.js', 'src/tools.js', 'src/integrity.js', 'host/main.cjs', 'cordis.patch.yml']) {
      if (!Object.hasOwn(manifest.files, required)) throw new Error(`manifest omits ${required}`)
    }
    for (const [path, expected] of Object.entries(manifest.files)) {
      if (typeof path !== 'string' || path.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part))
        || path.split('/').some(part => ['.', '..', 'node_modules', '.git'].includes(part))
        || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`invalid manifest entry: ${path}`)
      const parts = path.split('/')
      for (let i = 1; i <= parts.length; i++) {
        const stat = lstatSync(new URL(parts.slice(0, i).join('/'), root))
        if (stat.isSymbolicLink() || (i === parts.length ? !stat.isFile() : !stat.isDirectory())) throw new Error(`unsupported file shape: ${path}`)
      }
      const actual = createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex')
      if (actual !== expected) throw new Error(`content mismatch: ${path}`)
    }
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    if (pkg.name !== manifest.name || pkg.version !== manifest.version) throw new Error('package version differs from integrity manifest')
    return { version: manifest.version, filesChecked: Object.keys(manifest.files).length, directory: fileURLToPath(root) }
  } catch (error) {
    throw invalid(error.message)
  }
}
