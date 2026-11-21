// Checks (and with --write fixes) sizes and SHA-256 in src/main/voice/manifest.data.json.
//   node scripts/voice-manifest.mjs [--proto <dir>] [--hf] [--write]
// --proto: local copy of the prototype (default C:\dev\qclod-voice-proto): models\<repo-dir>\..., gpu\...
// --hf:    also compare with the Hugging Face tree API (lfs.oid is the SHA-256, lfs.size the size).
// A mismatch is a stop and a question to the coordinator, not something to "fix" quietly.
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DATA = new URL('../src/main/voice/manifest.data.json', import.meta.url)
const argv = process.argv.slice(2)
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined)
const proto = arg('--proto') ?? 'C:/dev/qclod-voice-proto'

const GIGA = 'sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16'
const PARA = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const LOCAL = {
  'silero-vad/silero_vad.onnx': join(proto, 'models', 'silero_vad.onnx'),
  'gigaam-v3/': join(proto, 'models', GIGA),
  'parakeet-v3/': join(proto, 'models', PARA),
  'whisper-turbo-cuda/ggml-large-v3-turbo-q5_0.bin': join(proto, 'gpu', 'ggml-large-v3-turbo-q5_0.bin'),
  'whisper-turbo-cuda/whisper-bin-win-cuda-12.4.0-x64.zip': join(proto, 'gpu', 'cuda.zip')
}
const localPath = (dir, name) => LOCAL[`${dir}/${name}`] ?? join(LOCAL[`${dir}/`] ?? '', name)

async function sha256(path) {
  const h = createHash('sha256')
  for await (const c of createReadStream(path)) h.update(c)
  return h.digest('hex')
}

const data = JSON.parse(readFileSync(DATA, 'utf8'))
const entries = [
  { dir: data.vad.dir, f: data.vad.file },
  ...Object.values(data.models).flatMap((m) => m.files.map((f) => ({ dir: m.dir, f })))
]

const hfTrees = new Map()
async function hfInfo(url, name) {
  const m = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\//.exec(url)
  if (!m) return null
  if (!hfTrees.has(m[1])) {
    const r = await fetch(`https://huggingface.co/api/models/${m[1]}/tree/main`)
    if (!r.ok) throw new Error(`HF ${m[1]}: HTTP ${r.status}`)
    hfTrees.set(m[1], await r.json())
  }
  const e = hfTrees.get(m[1]).find((x) => x.path === name)
  return e ? { size: e.lfs?.size ?? e.size, sha256: e.lfs?.oid ?? null } : undefined
}

let bad = 0
for (const { dir, f } of entries) {
  const path = localPath(dir, f.name)
  const size = statSync(path).size
  const sum = await sha256(path)
  const ok = size === f.size && sum === f.sha256
  let hfNote = ''
  if (argv.includes('--hf')) {
    const hf = await hfInfo(f.url, f.name)
    if (hf === undefined) { hfNote = '  HF: file not in the tree'; bad++ }
    else if (hf) {
      const same = hf.size === size && (hf.sha256 === null || hf.sha256 === sum)
      hfNote = same ? '  HF: ok' : `  HF: MISMATCH (size ${hf.size}, sha ${hf.sha256})`
      if (!same) bad++
    }
  }
  console.log(`${ok ? 'ok      ' : 'DIFFERS '}${dir}/${f.name}  ${size}  ${sum}${hfNote}`)
  if (!ok) {
    bad++
    if (argv.includes('--write')) { f.size = size; f.sha256 = sum }
  }
}
if (argv.includes('--write')) writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n')
process.exit(bad === 0 ? 0 : 1)
