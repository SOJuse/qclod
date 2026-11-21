// Ad-hoc signing of the Mac app (identity "-"): no Apple account, but Apple Silicon
// refuses to run a binary with no signature at all. electron-builder 25 does not
// accept "-" as an identity, so it is signed here, between packing and the DMG.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // A failure of either command throws and stops the build.
  execFileSync('codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
