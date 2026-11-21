'use strict'

const { lstatSync, opendirSync } = require('node:fs')
const { join } = require('node:path')

function downloadLimits(env) {
  const mib = 1024 * 1024
  const positive = (name, fallback) => {
    const raw = env[name]
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer`)
    return value
  }
  return {
    fileBytes: positive('BROWSER_USE_DOWNLOAD_MAX_FILE_BYTES', 256 * mib),
    concurrent: positive('BROWSER_USE_DOWNLOAD_MAX_CONCURRENT', 4),
    directoryBytes: positive('BROWSER_USE_DOWNLOAD_MAX_DIRECTORY_BYTES', 2048 * mib),
  }
}

function remainingDiskBudget(root, limit, reservations) {
  let remaining = limit
  const reserved = new Set()
  for (const { directory, budget } of reservations) {
    reserved.add(directory)
    remaining -= budget
    if (remaining <= 0) return 0
  }
  const directories = [root]
  while (directories.length && remaining > 0) {
    const path = directories.pop()
    let scan
    try { scan = opendirSync(path) } catch (error) {
      if (path === root && error.code === 'ENOENT') return remaining
      throw error
    }
    try {
      let entry
      while (remaining > 0 && (entry = scan.readSync())) {
        const child = join(path, entry.name)
        if (reserved.has(child) || entry.isSymbolicLink()) continue
        if (entry.isDirectory()) directories.push(child)
        else if (entry.isFile()) {
          const stat = lstatSync(child)
          if (stat.isFile()) remaining -= stat.size
        }
      }
    } finally { scan.closeSync() }
  }
  return Math.max(0, remaining)
}

module.exports = { downloadLimits, remainingDiskBudget }
