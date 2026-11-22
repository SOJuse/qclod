import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { VoiceModelId } from '../../../src/shared/voice'

const RATE = 16_000

/** 16 kHz mono 16-bit WAV: a 440 Hz tone at amplitude 0.3, then silence, per segment. Chromium's fake microphone plays it once. */
export function writeSpeechWav(dir: string, segments: Array<{ toneMs: number; silenceMs: number }>): string {
  const samples: number[] = []
  for (const s of segments) {
    const tone = Math.round((s.toneMs / 1000) * RATE)
    for (let i = 0; i < tone; i++) samples.push(0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE))
    const silence = Math.round((s.silenceMs / 1000) * RATE)
    for (let i = 0; i < silence; i++) samples.push(0)
  }
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2))
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'speech.wav')
  writeFileSync(path, Buffer.concat([head, data]))
  return path
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** The file names a model's paths look for (ModelStore.paths): sherpa's four, or Whisper's ggml and zip. */
function namesOf(id: VoiceModelId): string[] {
  return id === 'whisper-turbo-cuda'
    ? ['ggml-large-v3-turbo.bin', 'whisper-cuda.zip']
    : ['encoder.int8.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
}

interface FileEntry {
  name: string
  size: number
  sha256: string
  urls: string[]
  unpack?: 'zip'
}

function entry(name: string, body: Buffer, urls: string[]): FileEntry {
  const e: FileEntry = { name, size: body.length, sha256: sha256(body), urls }
  if (name.endsWith('.zip')) e.unpack = 'zip'
  return e
}

export const VAD_NAME = 'silero_vad.onnx'

/**
 * A manifest (the shape of MANIFESTS plus "vad") for one model whose files
 * are served at `<primary>/<name>` and, as the second address, `<mirror>/<name>`.
 */
export function writeDownloadManifest(
  dir: string,
  id: VoiceModelId,
  files: Record<string, Buffer>,
  addresses: { primary: string; mirror?: string }
): string {
  const urls = (name: string): string[] =>
    addresses.mirror ? [`${addresses.primary}/${name}`, `${addresses.mirror}/${name}`] : [`${addresses.primary}/${name}`]
  const { [VAD_NAME]: vad, ...model } = files
  if (!vad) throw new Error('writeDownloadManifest: the VAD file is part of every download')
  const manifest = {
    vad: entry(VAD_NAME, vad, urls(VAD_NAME)),
    [id]: { id, version: 1, dir: id, files: Object.entries(model).map(([name, body]) => entry(name, body, urls(name))) }
  }
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'voice-manifest.json')
  writeFileSync(path, JSON.stringify(manifest))
  return path
}

/** Small model files: 1 KB each (or `size`), each its own bytes. */
export function modelFiles(id: VoiceModelId, size = 1024): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  for (const name of [VAD_NAME, ...namesOf(id)]) {
    const b = Buffer.alloc(size)
    for (let i = 0; i < size; i++) b[i] = (i * 31 + name.length * 7) & 0xff
    out[name] = b
  }
  return out
}

/** Пишет маленький манифест (по 1 КБ на файл) и готовую модель по нему; путь к манифесту — в QCLOD_FAKE_VOICE_MANIFEST того же запуска. */
export function seedVoiceModel(userData: string, id: VoiceModelId): { manifestPath: string } {
  const files = modelFiles(id)
  const manifestPath = writeDownloadManifest(userData, id, files, { primary: 'http://127.0.0.1:9' })
  // modelsRoot(userData): the e2e profile lives in the ASCII temp folder.
  const root = join(userData, 'models')
  mkdirSync(join(root, 'silero-vad'), { recursive: true })
  writeFileSync(join(root, 'silero-vad', VAD_NAME), files[VAD_NAME]!)
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const names = namesOf(id)
  for (const name of names) {
    if (name.endsWith('.zip')) {
      mkdirSync(join(dir, 'cuda', 'Release'), { recursive: true })
      writeFileSync(join(dir, 'cuda', 'Release', 'whisper-server.exe'), Buffer.alloc(16))
    } else {
      writeFileSync(join(dir, name), files[name]!)
    }
  }
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ version: 1, files: names }))
  return { manifestPath }
}

export interface ModelServer {
  /** The primary address; the mirror is `mirror`. */
  url: string
  mirror: string
  /** Every request, in order: its path and its Range header. */
  requests: Array<{ path: string; range: string | undefined }>
  close(): Promise<void>
}

/**
 * Serves `files` at `/p/<name>` (the primary) and `/m/<name>` (the mirror),
 * with Range. Faults, on the primary only: `dropAfterBytes` — the very first
 * request (without Range) breaks off after that many bytes;
 * `corrupt` — those files come with their first byte flipped. `chunkMs`
 * paces the bodies (4 KB a step), so a progress can be seen.
 */
export function startModelServer(
  files: Record<string, Buffer>,
  faults: { dropAfterBytes?: number; corrupt?: string[]; chunkMs?: number } = {}
): Promise<ModelServer> {
  const requests: ModelServer['requests'] = []
  let dropped = false
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')
    const range = req.headers.range
    requests.push({ path, range })
    const m = /^\/(p|m)\/(.+)$/.exec(path)
    const body0 = m ? files[m[2]!] : undefined
    if (!m || !body0) {
      res.writeHead(404).end()
      return
    }
    const primary = m[1] === 'p'
    const name = m[2]!
    let body = body0
    if (primary && faults.corrupt?.includes(name)) {
      body = Buffer.from(body0)
      body[0] = body[0]! ^ 0xff
    }
    let start = 0
    const r = range ? /^bytes=(\d+)-$/.exec(range) : null
    if (r) {
      start = Number(r[1])
      if (start >= body.length) {
        res.writeHead(416).end()
        return
      }
    }
    const slice = body.subarray(start)
    res.writeHead(r ? 206 : 200, {
      'Content-Length': String(slice.length),
      'Content-Type': 'application/octet-stream',
      ...(r ? { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
      'Accept-Ranges': 'bytes'
    })
    const drop = primary && !range && faults.dropAfterBytes !== undefined && !dropped
    if (drop) dropped = true
    const limit = drop ? Math.min(faults.dropAfterBytes!, slice.length) : slice.length
    const step = 4096
    let at = 0
    const pump = (): void => {
      if (at >= limit) {
        // A break comes after what was sent has been read (a stream that errors drops what it still holds).
        if (drop) setTimeout(() => res.destroy(), faults.chunkMs ?? 0)
        else res.end()
        return
      }
      const piece = slice.subarray(at, Math.min(limit, at + step))
      at += piece.length
      res.write(piece)
      if (faults.chunkMs) setTimeout(pump, faults.chunkMs)
      else setImmediate(pump)
    }
    pump()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const base = `http://127.0.0.1:${port}`
      resolve({
        url: `${base}/p`,
        mirror: `${base}/m`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      })
    })
  })
}
