// electron-builder's one afterPack hook, between packing and the installer/DMG.
//  1. Electron's fuses (stage 6, I8; scripts/fuses.cjs) on every platform: set
//     before any signature so the signature covers them.
//  2. Ad-hoc signing of the Mac app (identity "-"): no Apple account, but Apple
//     Silicon refuses to run a binary with no signature at all. electron-builder
//     25 does not accept "-" as an identity, so it is signed here.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const fuses = require('../scripts/fuses.cjs')

module.exports = async function afterPack(context) {
  await fuses.afterPack(context)
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // A failure of either command throws and stops the build.
  execFileSync('codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
