// Makes the relay a single-executable binary (Node 22 SEA) from out/relay/relay.cjs:
//   blob (node --experimental-sea-config) → a copy of this very node → postject
//   → dist-relay/qclod-relay-<platform>-<arch>, its .gz and the .gz's .sha256.
// --e2e: from out/relay-e2e into dist-relay-e2e (the ssh loop's binary, no .gz).
//
// Run on the target system (CI: ubuntu-latest for x64, ubuntu-24.04-arm for
// arm64): the binary is the node that runs this script. Probe 07 built and ran
// it this way with useSnapshot and useCodeCache off.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, constants } from 'node:zlib'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const e2e = process.argv.includes('--e2e')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const platform = process.platform === 'win32' ? 'win' : process.platform
const arch = process.arch
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

const input = join(root, e2e ? 'out/relay-e2e' : 'out/relay', 'relay.cjs')
const outDir = join(root, e2e ? 'dist-relay-e2e' : 'dist-relay')
const work = join(outDir, '.sea')
mkdirSync(work, { recursive: true })
statSync(input) // npm run build:relay first

const blob = join(work, 'relay.blob')
const config = join(work, 'sea-config.json')
writeFileSync(
  config,
  JSON.stringify({ main: input, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false })
)
execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' })

const binName = `qclod-relay-${platform}-${arch}${process.platform === 'win32' ? '.exe' : ''}`
const bin = join(outDir, binName)
rmSync(bin, { force: true })
copyFileSync(process.execPath, bin)
chmodSync(bin, 0o755)
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', bin])

const postject = createRequire(import.meta.url).resolve('postject/dist/cli.js')
execFileSync(
  process.execPath,
  [postject, bin, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SENTINEL, ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])],
  { stdio: 'inherit' }
)
rmSync(work, { recursive: true, force: true })

// It runs and says who it is, or nothing ships.
const said = JSON.parse(execFileSync(bin, ['version'], { encoding: 'utf8' }))
if (said.version !== version || said.proto !== 1) throw new Error(`${binName} version: ${JSON.stringify(said)}`)

if (!e2e) {
  const gzName = `qclod-relay-${version}-${platform}-${arch}.gz`
  const gz = gzipSync(readFileSync(bin), { level: constants.Z_BEST_COMPRESSION })
  writeFileSync(join(outDir, gzName), gz)
  const sha = createHash('sha256').update(gz).digest('hex')
  writeFileSync(join(outDir, `${gzName}.sha256`), `${sha}  ${gzName}\n`)
  console.log(`${gzName} ${gz.length} ${sha}`)
}
console.log(`${binName} ${statSync(bin).size}`)
