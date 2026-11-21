/**
 * Electron's fuses (I8): switches baked into the binary that no argument and
 * no env can turn back on. On Windows ssh runs Qclod.exe itself as askpass,
 * with a question whose text the server writes: whatever slips into its
 * command line must not open a Node inspector or take NODE_OPTIONS.
 *
 * RunAsNode stays on: the Mac's askpass.sh runs the app with
 * ELECTRON_RUN_AS_NODE=1 (decision 5), and that run gets its question as an
 * argument of sh's "$@", never through a parser.
 *
 * The wire is Electron's own (@electron/fuses, docs/tutorial/fuses.md): the
 * sentinel, a version byte (1), a count byte, then one byte per fuse —
 * '0' off, '1' on, 'r' removed. Written here rather than added as a package:
 * the lane takes no new dependencies.
 */
'use strict'
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii')

/** FuseV1Options, in Electron's order. */
const FUSE = Object.freeze({
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7
})

/** What Qclod's builds set. */
const QCLOD_FUSES = Object.freeze({
  [FUSE.EnableNodeOptionsEnvironmentVariable]: false,
  [FUSE.EnableNodeCliInspectArguments]: false,
  [FUSE.RunAsNode]: true
})

/** The fuse bytes as they are: index → '0' | '1' | 'r'. Throws when the binary has no fuses. */
function readFuses(buf) {
  const at = buf.indexOf(SENTINEL)
  if (at < 0) throw new Error('В бинарнике Electron нет фьюзов')
  const version = buf[at + SENTINEL.length]
  if (version !== 1) throw new Error(`Неизвестная версия фьюзов: ${version}`)
  const count = buf[at + SENTINEL.length + 1]
  const start = at + SENTINEL.length + 2
  const out = []
  for (let i = 0; i < count; i++) out.push(String.fromCharCode(buf[start + i]))
  return { start, fuses: out }
}

/** Sets `wanted` (index → on/off) in a copy of `buf`; a removed fuse or one past the count throws. */
function flipFuses(buf, wanted = QCLOD_FUSES) {
  const out = Buffer.from(buf)
  const { start, fuses } = readFuses(out)
  for (const [key, on] of Object.entries(wanted)) {
    const i = Number(key)
    if (i >= fuses.length) throw new Error(`Фьюза ${i} нет в этом Electron`)
    if (fuses[i] === 'r') throw new Error(`Фьюз ${i} удалён в этом Electron`)
    out[start + i] = (on ? '1' : '0').charCodeAt(0)
  }
  return out
}

/** The file that carries the fuses: the exe, or on a Mac the framework inside the .app. */
function fuseBinaryPath(platform, appOutDir, productFilename, executableName) {
  if (platform === 'darwin' || platform === 'mas') {
    return join(appOutDir, `${productFilename}.app`, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
  }
  if (platform === 'win32') return join(appOutDir, `${productFilename}.exe`)
  return join(appOutDir, executableName || productFilename)
}

/** electron-builder's afterPack: before signing, so the signature covers the set fuses. */
async function afterPack(context) {
  const info = context.packager.appInfo
  const file = fuseBinaryPath(
    context.electronPlatformName,
    context.appOutDir,
    info.productFilename,
    context.packager.executableName
  )
  writeFileSync(file, flipFuses(readFileSync(file)))
  console.log(`  • fuses set  file=${file}`)
}

module.exports = { FUSE, QCLOD_FUSES, SENTINEL, readFuses, flipFuses, fuseBinaryPath, afterPack, default: afterPack }
