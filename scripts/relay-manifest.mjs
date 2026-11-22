// build/relay-manifest.json from the relay's .gz.sha256 files (dist-relay/):
//   { "version": "<ver>", "assets": { "x64": { "name", "sha256", "size" }, "arm64": { … } } }
// Qclod ships it (extraResources) and checks every downloaded relay against it
// (decision 3). Both Linux architectures are required; --allow-empty writes a
// manifest with what there is — a local `npm run dist` with no relay built.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifestFrom } from './relayManifest.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const allowEmpty = process.argv.includes('--allow-empty')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const dir = join(root, 'dist-relay')

let names = []
try {
  names = readdirSync(dir)
} catch {
  names = []
}
const files = names
  .filter((n) => n.endsWith('.gz.sha256'))
  .map((n) => {
    const gz = n.slice(0, -'.sha256'.length)
    return { name: gz, sha256Line: readFileSync(join(dir, n), 'utf8'), size: statSync(join(dir, gz)).size }
  })

const manifest = manifestFrom(version, files)
const missing = ['x64', 'arm64'].filter((a) => !manifest.assets[a])
if (missing.length > 0 && !allowEmpty) {
  console.error(`нет посредника для ${missing.join(', ')} в dist-relay/ (версия ${version})`)
  process.exit(1)
}
mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build', 'relay-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`build/relay-manifest.json: ${Object.keys(manifest.assets).join(', ') || 'пусто'}`)
