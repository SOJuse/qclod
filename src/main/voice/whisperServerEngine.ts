import { spawn as nodeSpawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import type { SpeechEngine } from './engine'
import { encodeWav16 } from './wav'

export interface ServerChild {
  pid?: number
  stdout: Readable | null
  stderr: Readable | null
  on(e: 'exit', f: (code: number | null, signal: string | null) => void): unknown
  kill(): boolean
}

export type SpawnLike = (
  file: string,
  args: string[],
  opts: { cwd: string; windowsHide: boolean }
) => ServerChild

export interface WhisperServerOptions {
  exe: string
  ggml: string
  threads: number
  prompt: string
  onPid(pid: number): void
  spawn?: SpawnLike
  fetch?: typeof fetch
  readyTimeoutMs?: number
}

type GpuError = Error & { code: 'gpu-failed' }

const HOST = '127.0.0.1'
const POLL_MS = 150
const LOG_LIMIT = 64 * 1024
const CUDA_FOUND = /found (\d+) CUDA devices/
const CUDA_FAILED = /no CUDA devices|CUDA error|failed to initialize CUDA/i

/** What Whisper writes on silence or noise — subtitles credits it learned from. */
const HALLUCINATIONS = [
  /^субтитр/i,
  /продолжение следует/i,
  /спасибо за просмотр/i,
  /редактор субтитров/i,
  /DimaTorzok/i
]

export function isWhisperHallucination(text: string): boolean {
  const t = text.trim()
  return HALLUCINATIONS.some((re) => re.test(t))
}

function gpuFailed(message: string): GpuError {
  return Object.assign(new Error(message), { code: 'gpu-failed' as const })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, HOST, () => {
      const address = s.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      s.close(() => (port > 0 ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Whisper large-v3-turbo on an NVIDIA card through whisper.cpp's
 * whisper-server (b5454): the server keeps the model loaded, and each decode
 * is one HTTP request on 127.0.0.1. A server that came up without CUDA is a
 * failure — on the CPU it is slower than speech (decision 2).
 */
export class WhisperServerEngine implements SpeechEngine {
  readonly model = 'whisper-turbo-cuda' as const
  private readonly spawn: SpawnLike
  private readonly fetch: typeof fetch
  private readonly readyTimeoutMs: number
  private child: ServerChild | null = null
  private port = 0
  private log = ''
  private exited = false

  constructor(private readonly o: WhisperServerOptions) {
    this.spawn = o.spawn ?? ((file, args, opts) => nodeSpawn(file, args, opts))
    this.fetch = o.fetch ?? globalThis.fetch
    this.readyTimeoutMs = o.readyTimeoutMs ?? 30_000
  }

  async load(): Promise<void> {
    try {
      this.port = await freePort()
      const args = ['-m', this.o.ggml, '-l', 'ru', '-t', String(this.o.threads), '--host', HOST]
      args.push('--port', String(this.port), '-nt')
      const child = this.spawn(this.o.exe, args, { cwd: dirname(this.o.exe), windowsHide: true })
      this.child = child
      if (typeof child.pid === 'number') this.o.onPid(child.pid)
      const keep = (d: Buffer | string): void => {
        if (this.log.length < LOG_LIMIT) this.log += String(d)
      }
      child.stderr?.on('data', keep)
      child.stdout?.on('data', keep)
      child.on('exit', () => {
        this.exited = true
      })
      await this.waitReady()
      // Warm-up: the first request pays for CUDA kernels.
      await this.decode(new Float32Array(8000))
    } catch (err) {
      await this.dispose()
      throw err instanceof Error && (err as Partial<GpuError>).code === 'gpu-failed'
        ? err
        : gpuFailed(err instanceof Error ? err.message : String(err))
    }
  }

  async decode(pcm: Float32Array): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(encodeWav16(pcm))], { type: 'audio/wav' }), 'phrase.wav')
    form.append('response_format', 'json')
    form.append('temperature', '0.0')
    form.append('language', 'ru')
    form.append('prompt', this.o.prompt)
    const res = await this.fetch(`http://${HOST}:${this.port}/inference`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`whisper-server answered ${res.status}`)
    const body = (await res.json()) as { text?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    return isWhisperHallucination(text) ? '' : text
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = null
    if (child !== null && !this.exited) child.kill()
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    for (;;) {
      const failed = CUDA_FAILED.exec(this.log)
      if (failed !== null) throw gpuFailed(this.line(failed.index))
      if (this.exited) throw gpuFailed('whisper-server exited before it was ready')
      if (await this.answers()) {
        const found = CUDA_FOUND.exec(this.log)
        if (found === null || Number(found[1]) < 1) throw gpuFailed('whisper-server came up without CUDA')
        return
      }
      if (Date.now() >= deadline) throw gpuFailed('whisper-server did not start in time')
      await sleep(POLL_MS)
    }
  }

  private async answers(): Promise<boolean> {
    try {
      const res = await this.fetch(`http://${HOST}:${this.port}/`, { signal: AbortSignal.timeout(1000) })
      await res.arrayBuffer().catch(() => undefined)
      return res.status === 200
    } catch {
      return false
    }
  }

  private line(at: number): string {
    const start = this.log.lastIndexOf('\n', at) + 1
    const end = this.log.indexOf('\n', at)
    return this.log.slice(start, end === -1 ? undefined : end).trim()
  }
}
