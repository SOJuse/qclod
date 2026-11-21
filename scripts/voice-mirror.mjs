// Creates the pre-release "voice-models-v1" with every file of the manifest (run by hand, needs `gh auth login`).
//   node scripts/voice-mirror.mjs [--dry-run]
// --dry-run prints the plan and the `gh` command; downloads and uploads nothing.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MIRROR_TAG, mirrorUploadArgs, stagedPath } from './voiceMirror.mjs'

const dry = process.argv.includes('--dry-run')
const data = JSON.parse(readFileSync(new URL('../src/main/voice/manifest.data.json', import.meta.url), 'utf8'))
const files = [
  { dir: data.vad.dir, ...data.vad.file },
  ...Object.values(data.models).flatMap((m) => m.files.map((f) => ({ dir: m.dir, ...f })))
]
const staging = join(tmpdir(), 'qclod-voice-mirror')
const args = mirrorUploadArgs(MIRROR_TAG, files, staging)

console.log(`Mirror release ${MIRROR_TAG} (pre-release), ${files.length} files, staged in ${staging}`)
for (const f of files) {
  console.log(`  ${(f.size / 1e6).toFixed(1).padStart(8)} MB  ${stagedPath(staging, f.dir, f.name).split(/[\/]/).pop()}  <-  ${f.url}`)
}
console.log(`gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
if (dry) process.exit(0)

mkdirSync(staging, { recursive: true })
for (const f of files) {
  const target = stagedPath(staging, f.dir, f.name)
  console.log(`download ${f.url}`)
  const res = await fetch(f.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${f.url}: HTTP ${res.status}`)
  const hash = createHash('sha256')
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => hash.update(c))
  await pipeline(body, createWriteStream(target))
  if (hash.digest('hex') !== f.sha256) throw new Error(`${f.name}: SHA-256 differs from the manifest, stop`)
}
const r = spawnSync('gh', args, { stdio: 'inherit' })
process.exit(r.status ?? 1)
