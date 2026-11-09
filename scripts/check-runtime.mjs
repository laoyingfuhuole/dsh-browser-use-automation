/**
 * Electron 运行环境预检：不启动浏览器、不下载文件、不改 profile。
 * Electron 的 npm 包与二进制是两项独立产物；npm registry 镜像不等同于二进制镜像。
 * 不要求完整性清单已更新，方便开发者在修改源码后仍能检查本机依赖。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectElectronRuntime } from '../src/client.js'

const args = process.argv.slice(2)
try {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) throw new Error('Usage: npm run check:runtime -- [--json]')
  const runtime = inspectElectronRuntime()
  const packages = runtime.packages.map(pkg => ({ ...pkg, installScript: existsSync(join(pkg.root, 'install.js')) ? join(pkg.root, 'install.js') : null }))
  const result = {
    ...runtime, packages,
    platform: process.platform, arch: process.arch,
    statusMeaning: runtime.status === 'ready' ? 'Executable file found; actual Electron version and launch still require the host handshake.'
      : runtime.status === 'binary-missing' ? 'Electron package installed, but binary download/install is incomplete or not executable.'
        : runtime.status === 'invalid-override' ? 'ELECTRON_PATH is explicit but invalid; it is not silently ignored.'
          : 'No declared package or profile executable found.',
    repair: {
      automaticChanges: false,
      packageMissing: 'Use this DSH profile’s existing package manager to install the declared Electron dependency. Do not mix package managers.',
      binaryMissing: 'After approving the download, invoke the exact installed Electron install.js using Node, for example: node "<packages[].installScript>". This may access the network; this diagnostic never runs it.',
      mirror: 'npm --registry only controls package metadata/downloads. Configure ELECTRON_MIRROR explicitly if an Electron binary mirror is required, and verify the chosen source. No mirror is selected automatically.',
      override: 'Set ELECTRON_PATH to an actual compatible bare Electron executable, not a .cmd shim, app directory, packaged DSH executable, or an archive.',
    },
    packageDirectory: dirname(fileURLToPath(new URL('../package.json', import.meta.url))),
  }
  if (args[0] === '--json') console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`${runtime.status === 'ready' ? 'READY' : 'NOT READY'}: ${runtime.status}`)
    if (runtime.path) console.log(`Executable: ${runtime.path}`)
    for (const pkg of packages) {
      console.log(`Package: ${pkg.root} (npm metadata ${pkg.version ?? 'unknown'})`)
      if (!pkg.ready && pkg.installScript) console.log(`Approved download repair: node ${JSON.stringify(pkg.installScript)}`)
    }
    console.log(result.statusMeaning)
    console.log(result.repair.mirror)
    if (runtime.status !== 'ready') console.log(runtime.status === 'invalid-override' ? result.repair.override : result.repair.packageMissing)
    console.log('Read-only filesystem diagnosis; no browser, download, or profile update was started.')
  }
  process.exitCode = runtime.status === 'ready' ? 0 : 1
} catch (error) {
  if (args.includes('--json')) console.log(JSON.stringify({ status: 'diagnostic-error', error: error.message }))
  else console.error(`ERROR: ${error.message}`)
  process.exitCode = 2
}
