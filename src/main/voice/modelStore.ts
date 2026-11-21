import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { VOICE_MODEL_IDS, type ModelInstallState, type VoiceModelId, type VoiceModelView } from '../../shared/voice'
import { DownloadError, fetchFile, fileSha256 } from './download'
import { activeManifests, activeVad, VAD_DIR, type ManifestFile, type ModelManifest } from './manifest'
import type { ModelPaths } from './modelPaths'
import { VC_REDIST_REASON } from './nvidia'

export interface ModelStoreDeps {
  root: string
  fetch: typeof fetch
  platform: string
  /** fs.statfs */
  freeBytes(dir: string): Promise<number>
  /** %SystemRoot%\System32\tar.exe -xf <zip> -C <dest>; the signal stops it (a cancel while unpacking). */
  extractZip(zip: string, dest: string, signal?: AbortSignal): Promise<void>
  /** Until task 7: null means "not checked" and Whisper is unavailable. */
  nvidia?: (() => Promise<{ ok: true } | { ok: false; reason: string }>) | null
  /** Whether the Visual C++ runtime whisper-server.exe needs is installed (I4); not given — taken as yes. */
  vcRuntime?: () => boolean
}

const UNPACKED_WHISPER_BYTES = 1.8 * 1024 * 1024 * 1024
const MIN_NOTIFY_GAP_MS = 200
const WHISPER_RELEASE = ['cuda', 'Release'] as const
const WHISPER_EXE = [...WHISPER_RELEASE, 'whisper-server.exe'] as const
/** whisper-server.exe and the DLLs it loads, all in the b5454 zip's Release folder (M3). */
const WHISPER_FILES = [
  'whisper-server.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cuda.dll',
  'cudart64_12.dll',
  'cublas64_12.dll',
  'cublasLt64_12.dll'
] as const

/** "232 МБ", "1,3 ГБ": one comma, МБ up to 1000, then ГБ. */
export function formatSize(bytes: number): string {
  const mb = bytes / 1e6
  if (mb < 1000) return `${Math.max(1, Math.round(mb))} МБ`
  return `${(mb / 1000).toFixed(1).replace('.', ',')} ГБ`
}

function noAccess(err: unknown): boolean {
  if (err instanceof DownloadError) return err.code === 'access'
  const code = (err as { code?: unknown } | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

/** What the model's card says about a failed download. `root` — the models' folder, for «no access» (M4). */
export function errorText(err: unknown, root?: string): string {
  if (noAccess(err)) return root ? `Нет доступа к папке моделей: ${root}` : 'Нет доступа к папке моделей.'
  const code = err instanceof DownloadError ? err.code : null
  switch (code) {
    case 'network':
      return 'Нет связи с сервером. Нажмите «Повторить» — скачивание продолжится с того же места.'
    case 'checksum':
      return 'Файл скачался повреждённым и с основного сервера, и с запасного. Попробуйте позже.'
    case 'extract':
      return 'Не удалось распаковать файлы для видеокарты.'
    case 'disk':
      return err instanceof DownloadError && err.message !== 'disk' ? err.message : 'Не хватает места на диске.'
    default:
      return err instanceof Error && err.message ? err.message : 'Не удалось скачать модель.'
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

interface Job {
  controller: AbortController
  done: Promise<void>
  /** Its turn came (the queue's previous job ended): a cancel now stops a running download. */
  started: boolean
}

export class ModelStore {
  private readonly manifests: Record<VoiceModelId, ModelManifest>
  private readonly vad: ManifestFile
  private readonly transient = new Map<VoiceModelId, ModelInstallState>()
  private readonly jobs = new Map<VoiceModelId, Job>()
  /** Being deleted: not ready for the voice process, even while its files are still there (I3). */
  private readonly removing = new Set<VoiceModelId>()
  private tail: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private lastEmit = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(private readonly deps: ModelStoreDeps) {
    this.manifests = activeManifests()
    this.vad = activeVad()
  }

  // ---------------------------------------------------------------- paths

  private modelDir(m: ModelManifest): string {
    return join(this.deps.root, m.dir)
  }
  private vadDir(): string {
    return join(this.deps.root, VAD_DIR)
  }
  private vadPath(): string {
    return join(this.vadDir(), this.vad.name)
  }

  // -------------------------------------------------------------- readiness

  private hasMarker(m: ModelManifest): boolean {
    try {
      const raw = JSON.parse(readFileSync(join(this.modelDir(m), 'installed.json'), 'utf8')) as { version?: unknown }
      return raw.version === m.version
    } catch {
      return false
    }
  }

  /** The zip for the card is unpacked: the server and every DLL it loads. */
  private whisperUnpacked(dir: string): boolean {
    return WHISPER_FILES.every((f) => existsSync(join(dir, ...WHISPER_RELEASE, f)))
  }

  private filesPresent(m: ModelManifest): boolean {
    const dir = this.modelDir(m)
    return m.files.every((f) => (f.unpack === 'zip' ? this.whisperUnpacked(dir) : fileSize(join(dir, f.name)) === f.size))
  }

  /** Ready: installed.json of the manifest's version, every file of its size. Sums are not rechecked at start. */
  private isReady(m: ModelManifest): boolean {
    return this.hasMarker(m) && this.filesPresent(m) && fileSize(this.vadPath()) === this.vad.size
  }

  paths(id: VoiceModelId): ModelPaths | null {
    const m = this.manifests[id]
    if (!m || this.removing.has(id) || !this.isReady(m)) return null
    const dir = this.modelDir(m)
    const vad = this.vadPath()
    if (id === 'whisper-turbo-cuda') {
      const ggml = m.files.find((f) => f.unpack === undefined)
      if (!ggml) return null
      return { kind: 'whisper', model: 'whisper-turbo-cuda', exe: join(dir, ...WHISPER_EXE), ggml: join(dir, ggml.name), vad }
    }
    const pick = (prefix: string): string | null => {
      const f = m.files.find((x) => x.name.startsWith(prefix))
      return f ? join(dir, f.name) : null
    }
    const encoder = pick('encoder')
    const decoder = pick('decoder')
    const joiner = pick('joiner')
    const tokens = pick('tokens')
    if (!encoder || !decoder || !joiner || !tokens) return null
    return { kind: 'sherpa', model: id as 'gigaam-v3' | 'parakeet-v3', vad, encoder, decoder, joiner, tokens }
  }

  // --------------------------------------------------------------- snapshot

  private async availability(
    id: VoiceModelId
  ): Promise<Pick<VoiceModelView, 'available' | 'unavailableReason' | 'fix'>> {
    if (id !== 'whisper-turbo-cuda') return { available: true }
    if (this.deps.platform !== 'win32') return { available: false, unavailableReason: 'Пока только на Windows' }
    const check = this.deps.nvidia ? await this.deps.nvidia() : null
    if (!check) return { available: false, unavailableReason: 'Видеокарта не проверена' }
    if (!check.ok) return { available: false, unavailableReason: check.reason }
    // whisper-server.exe and its DLLs need MSVCP140/VCRUNTIME140(_1), which the zip does not carry (I4).
    if (this.deps.vcRuntime && !this.deps.vcRuntime()) {
      return { available: false, unavailableReason: VC_REDIST_REASON, fix: 'vc-redist' }
    }
    return { available: true }
  }

  async snapshot(): Promise<VoiceModelView[]> {
    return Promise.all(
      VOICE_MODEL_IDS.map(async (id) => {
        const m = this.manifests[id]
        const state: ModelInstallState = this.transient.get(id) ?? (m && this.isReady(m) ? { kind: 'ready' } : { kind: 'absent' })
        return { id, state, ...(await this.availability(id)) }
      })
    )
  }

  // --------------------------------------------------------------- download

  /** One at a time: the second waits in the queue. Resolves on cancel; rejects on an error (the state says why). */
  download(id: VoiceModelId): Promise<void> {
    const existing = this.jobs.get(id)
    if (existing) return existing.done
    const m = this.manifests[id]
    if (!m) return Promise.reject(new Error(`unknown model ${id}`))
    const controller = new AbortController()
    const job: Job = { controller, done: Promise.resolve(), started: false }
    this.setState(id, { kind: 'downloading', done: 0, total: 0 })
    const ran = this.tail.then(() => {
      // Cancelled while it waited its turn: already let go below.
      if (controller.signal.aborted) return
      job.started = true
      return this.run(id, m, controller)
    })
    this.tail = ran.catch(() => {})
    // A cancel (or a deletion) of a job still in the queue does not wait for the download before it (M1).
    const dequeued = new Promise<void>((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          if (job.started) return
          if (this.jobs.get(id) === job) this.jobs.delete(id)
          this.transient.delete(id)
          this.emit()
          resolve()
        },
        { once: true }
      )
    })
    job.done = Promise.race([ran, dequeued]).finally(() => {
      if (this.jobs.get(id) === job) this.jobs.delete(id)
    })
    this.jobs.set(id, job)
    return job.done
  }

  /** The .part files stay for a resume. */
  cancel(id: VoiceModelId): void {
    this.jobs.get(id)?.controller.abort()
  }

  /**
   * Deletes a model's folder. `release` lets the voice process go first
   * (VoiceHost.release, I3): Windows keeps a running program's files locked,
   * and a half-deleted folder would stay on the disk. While this runs, the
   * model is not ready for a new recording.
   */
  async remove(id: VoiceModelId, release?: () => Promise<void>): Promise<void> {
    const m = this.manifests[id]
    this.removing.add(id)
    try {
      this.cancel(id)
      await this.jobs.get(id)?.done.catch(() => {})
      await release?.()
      if (!m) return
      // A process just closed may hold its files a moment longer: rm retries.
      await rm(this.modelDir(m), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      this.transient.delete(id)
      // The VAD stays while another model has it or is downloading it (M2).
      const needed = VOICE_MODEL_IDS.some(
        (other) => other !== id && this.manifests[other] && (this.hasMarker(this.manifests[other]) || this.jobs.has(other))
      )
      if (!needed) await rm(this.vadDir(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } finally {
      this.removing.delete(id)
    }
    this.emit()
  }

  private async run(id: VoiceModelId, m: ModelManifest, controller: AbortController): Promise<void> {
    const signal = controller.signal
    try {
      if (signal.aborted) throw new DownloadError('aborted')
      const avail = await this.availability(id)
      if (!avail.available) throw new Error(avail.unavailableReason ?? 'Модель недоступна')
      await mkdir(this.deps.root, { recursive: true })

      const dir = this.modelDir(m)
      const todo: Array<{ file: ManifestFile; dir: string }> = []
      /** A zip already downloaded whose unpacking failed: unpacked again, not downloaded again (M3). */
      const toUnpack: ManifestFile[] = []
      if (fileSize(this.vadPath()) !== this.vad.size) todo.push({ file: this.vad, dir: this.vadDir() })
      for (const f of m.files) {
        if (f.unpack === 'zip') {
          if (this.whisperUnpacked(dir)) continue
          if (await this.keptZip(id, f, dir)) {
            toUnpack.push(f)
            continue
          }
          if (signal.aborted) throw new DownloadError('aborted')
        } else if (fileSize(join(dir, f.name)) === f.size) {
          continue
        }
        todo.push({ file: f, dir })
      }

      const total = todo.reduce((s, t) => s + t.file.size, 0)
      const unpacked = toUnpack.length > 0 || todo.some((t) => t.file.unpack === 'zip') ? UNPACKED_WHISPER_BYTES : 0
      const need = 1.1 * (total + unpacked)
      const free = await this.deps.freeBytes(this.deps.root)
      if (free < need) {
        throw new DownloadError('disk', `Не хватает места на диске: нужно ${formatSize(need)}, свободно ${formatSize(free)}.`)
      }

      let finished = 0
      this.setState(id, { kind: 'downloading', done: 0, total })
      for (const { file, dir: target } of todo) {
        await fetchFile(file, target, {
          fetch: this.deps.fetch,
          signal,
          onBytes: (bytes) => this.setState(id, { kind: 'downloading', done: finished + bytes, total })
        })
        finished += file.size
        if (file.unpack === 'zip') await this.unpack(id, file, target, signal)
      }
      for (const file of toUnpack) await this.unpack(id, file, dir, signal)

      this.setState(id, { kind: 'verifying' })
      await writeFile(join(dir, 'installed.json'), JSON.stringify({ version: m.version, files: m.files.map((f) => f.name) }))
      this.transient.delete(id)
      this.emit()
    } catch (err) {
      if (err instanceof DownloadError && err.code === 'aborted') {
        this.transient.delete(id)
        this.emit()
        return
      }
      this.setState(id, { kind: 'error', message: errorText(err, this.deps.root) })
      throw err
    }
  }

  /** A zip of the right size left by a failed unpacking: kept if its sum is right, deleted if not. */
  private async keptZip(id: VoiceModelId, file: ManifestFile, dir: string): Promise<boolean> {
    const zip = join(dir, file.name)
    if (fileSize(zip) !== file.size) return false
    this.setState(id, { kind: 'verifying' })
    if ((await fileSha256(zip)) === file.sha256.toLowerCase()) return true
    await rm(zip, { force: true })
    return false
  }

  private async unpack(id: VoiceModelId, file: ManifestFile, dir: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DownloadError('aborted')
    this.setState(id, { kind: 'extracting' })
    const zip = join(dir, file.name)
    const dest = join(dir, 'cuda')
    try {
      await rm(dest, { recursive: true, force: true })
      await mkdir(dest, { recursive: true })
      await this.deps.extractZip(zip, dest, signal)
      if (signal.aborted) throw new DownloadError('aborted')
      if (!this.whisperUnpacked(dir)) throw new Error('whisper-server.exe or a DLL it needs is missing')
    } catch (e) {
      // The zip stays: it is whole (its sum was checked), the next try only unpacks it.
      await rm(dest, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (signal.aborted) throw new DownloadError('aborted')
      throw new DownloadError('extract', (e as Error).message)
    }
    await rm(zip, { force: true })
  }

  // ----------------------------------------------------------------- events

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private setState(id: VoiceModelId, state: ModelInstallState): void {
    this.transient.set(id, state)
    this.emit()
  }

  /** At most 5 notifications a second: progress is coalesced, a state change goes at the next free moment. */
  private emit(): void {
    const now = Date.now()
    const wait = this.lastEmit + MIN_NOTIFY_GAP_MS - now
    if (wait <= 0 && this.timer === null) {
      this.fire(now)
      return
    }
    this.dirty = true
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        if (this.dirty) this.fire(Date.now())
      }, Math.max(0, wait))
    }
  }

  private fire(now: number): void {
    this.lastEmit = now
    this.dirty = false
    for (const cb of [...this.listeners]) cb()
  }
}

