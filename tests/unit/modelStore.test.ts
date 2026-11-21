import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { formatSize, ModelStore, type ModelStoreDeps } from '../../src/main/voice/modelStore'

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const mk = (n: number, seed: number): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (i + seed) % 251))

const VAD = mk(3000, 1)
const ENC = mk(9000, 2)
const TOK = mk(500, 3)
const GGML = mk(7000, 4)
const ZIP = mk(6000, 5)

const entry = (name: string, body: Buffer, extra: object = {}) => ({
  name,
  size: body.length,
  sha256: sha(body),
  urls: [`http://x/${name}`],
  ...extra
})

let root: string
let manifestPath: string
let bodies: Map<string, Buffer>
let requests: string[]

function writeManifest(version = 1): void {
  const fake = {
    vad: entry('silero_vad.onnx', VAD),
    'gigaam-v3': {
      id: 'gigaam-v3',
      version,
      dir: 'gigaam-v3',
      files: [entry('encoder.int8.onnx', ENC), entry('decoder.onnx', TOK), entry('joiner.onnx', TOK), entry('tokens.txt', TOK)]
    },
    'parakeet-v3': {
      id: 'parakeet-v3',
      version: 1,
      dir: 'parakeet-v3',
      files: [entry('encoder.int8.onnx', ENC), entry('decoder.int8.onnx', TOK), entry('joiner.int8.onnx', TOK), entry('tokens.txt', TOK)]
    },
    'whisper-turbo-cuda': {
      id: 'whisper-turbo-cuda',
      version: 1,
      dir: 'whisper-turbo-cuda',
      files: [entry('ggml.bin', GGML), entry('cuda.zip', ZIP, { unpack: 'zip' })]
    }
  }
  writeFileSync(manifestPath, JSON.stringify(fake))
  bodies = new Map([
    ['silero_vad.onnx', VAD],
    ['encoder.int8.onnx', ENC],
    ['decoder.onnx', TOK],
    ['joiner.onnx', TOK],
    ['decoder.int8.onnx', TOK],
    ['joiner.int8.onnx', TOK],
    ['tokens.txt', TOK],
    ['ggml.bin', GGML],
    ['cuda.zip', ZIP]
  ])
}

const fakeFetch = (async (url: string | URL | Request) => {
  const u = String(url)
  requests.push(u)
  const body = bodies.get(u.split('/').pop()!)
  if (!body) return new Response(null, { status: 404 })
  return new Response(new Uint8Array(body), { status: 200 })
}) as typeof fetch

/** What whisper-server.exe needs next to it (the b5454 zip's Release folder). */
const WHISPER_RELEASE = [
  'whisper-server.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  'ggml-cuda.dll',
  'cudart64_12.dll',
  'cublas64_12.dll',
  'cublasLt64_12.dll'
]

function unzipFake(dest: string, files: readonly string[] = WHISPER_RELEASE): void {
  for (const f of files) {
    const path = join(dest, 'Release', f)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'MZ')
  }
}

function store(extra: Partial<ModelStoreDeps> = {}): ModelStore {
  return new ModelStore({
    root,
    fetch: fakeFetch,
    platform: 'win32',
    freeBytes: async () => 10 * 1024 ** 3,
    extractZip: async (_zip, dest) => unzipFake(dest),
    nvidia: async () => ({ ok: true }),
    ...extra
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qclod-ms-'))
  manifestPath = join(root, '..', `manifest-${Date.now()}-${Math.random()}.json`)
  requests = []
  writeManifest()
  vi.stubEnv('QCLOD_FAKE_VOICE_MANIFEST', manifestPath)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
  rmSync(manifestPath, { force: true })
})

const stateOf = async (s: ModelStore, id: string) => (await s.snapshot()).find((v) => v.id === id)!.state

describe('ModelStore', () => {
  test('готова только с installed.json и всеми файлами; выросла версия манифеста — снова absent', async () => {
    const s = store()
    expect(await stateOf(s, 'gigaam-v3')).toEqual({ kind: 'absent' })
    await s.download('gigaam-v3')
    expect(await stateOf(s, 'gigaam-v3')).toEqual({ kind: 'ready' })
    expect(s.paths('gigaam-v3')).toMatchObject({ kind: 'sherpa', model: 'gigaam-v3' })

    rmSync(join(root, 'gigaam-v3', 'tokens.txt'))
    expect(await stateOf(store(), 'gigaam-v3')).toEqual({ kind: 'absent' })
    writeFileSync(join(root, 'gigaam-v3', 'tokens.txt'), TOK)
    expect(await stateOf(store(), 'gigaam-v3')).toEqual({ kind: 'ready' })

    rmSync(join(root, 'gigaam-v3', 'installed.json'))
    expect(await stateOf(store(), 'gigaam-v3')).toEqual({ kind: 'absent' })
    writeFileSync(join(root, 'gigaam-v3', 'installed.json'), JSON.stringify({ version: 1 }))

    writeManifest(2)
    const grown = store()
    expect(await stateOf(grown, 'gigaam-v3')).toEqual({ kind: 'absent' })
    expect(grown.paths('gigaam-v3')).toBeNull()
  })

  test('места мало — ошибка disk до первого запроса', async () => {
    const s = store({ freeBytes: async () => 5000 })
    await expect(s.download('gigaam-v3')).rejects.toMatchObject({ code: 'disk' })
    expect(requests).toEqual([])
    const st = await stateOf(s, 'gigaam-v3')
    expect(st.kind).toBe('error')
    expect((st as { message: string }).message).toMatch(/^Не хватает места на диске: нужно .+, свободно .+\.$/)
  })

  test('вторая модель ждёт, пока качается первая', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = (async (url: string | URL | Request) => {
      if (String(url).endsWith('encoder.int8.onnx') && requests.every((r) => !r.includes('/encoder.int8.onnx'))) await gate
      return fakeFetch(url)
    }) as typeof fetch
    const s = store({ fetch: slow })
    const first = s.download('gigaam-v3')
    const second = s.download('parakeet-v3')
    await new Promise((r) => setTimeout(r, 50))
    expect(requests.some((r) => r.includes('joiner.int8.onnx'))).toBe(false)
    expect(await stateOf(s, 'parakeet-v3')).toMatchObject({ kind: 'downloading' })
    release()
    await Promise.all([first, second])
    expect(await stateOf(s, 'parakeet-v3')).toEqual({ kind: 'ready' })
    // VAD was fetched once for both
    expect(requests.filter((r) => r.endsWith('silero_vad.onnx'))).toHaveLength(1)
  })

  test('zip: extractZip вызван с путём модели, архив удалён, paths даёт whisper-server.exe', async () => {
    const extractZip = vi.fn(async (_z: string, dest: string, _signal?: AbortSignal) => unzipFake(dest))
    const s = store({ extractZip })
    await s.download('whisper-turbo-cuda')
    const dir = join(root, 'whisper-turbo-cuda')
    expect(extractZip).toHaveBeenCalledWith(join(dir, 'cuda.zip'), join(dir, 'cuda'), expect.any(AbortSignal))
    expect(existsSync(join(dir, 'cuda.zip'))).toBe(false)
    const p = s.paths('whisper-turbo-cuda')
    expect(p).toMatchObject({ kind: 'whisper', exe: join(dir, 'cuda', 'Release', 'whisper-server.exe'), ggml: join(dir, 'ggml.bin') })
  })

  test('распаковка не дала whisper-server.exe — extract', async () => {
    const s = store({ extractZip: async () => {} })
    await expect(s.download('whisper-turbo-cuda')).rejects.toMatchObject({ code: 'extract' })
    expect(await stateOf(s, 'whisper-turbo-cuda')).toEqual({
      kind: 'error',
      message: 'Не удалось распаковать файлы для видеокарты.'
    })
  })

  test('M3: распаковка без DLL рядом с whisper-server.exe — extract; готовность проверяет и DLL', async () => {
    const s = store({ extractZip: async (_z, dest) => unzipFake(dest, ['whisper-server.exe']) })
    await expect(s.download('whisper-turbo-cuda')).rejects.toMatchObject({ code: 'extract' })
    const good = store()
    await good.download('whisper-turbo-cuda')
    expect(good.paths('whisper-turbo-cuda')).not.toBeNull()
    rmSync(join(root, 'whisper-turbo-cuda', 'cuda', 'Release', 'ggml-cuda.dll'))
    expect(store().paths('whisper-turbo-cuda')).toBeNull()
    expect(await stateOf(store(), 'whisper-turbo-cuda')).toEqual({ kind: 'absent' })
  })

  test('M3: распаковка не удалась — «Повторить» не качает zip заново, а распаковывает скачанный', async () => {
    let fail = true
    const s = store({
      extractZip: async (_z, dest) => {
        if (fail) throw new Error('tar: Error exit delayed from previous errors')
        unzipFake(dest)
      }
    })
    await expect(s.download('whisper-turbo-cuda')).rejects.toMatchObject({ code: 'extract' })
    expect(existsSync(join(root, 'whisper-turbo-cuda', 'cuda.zip'))).toBe(true)
    fail = false
    await s.download('whisper-turbo-cuda')
    expect(requests.filter((r) => r.endsWith('/cuda.zip'))).toHaveLength(1)
    expect(await stateOf(s, 'whisper-turbo-cuda')).toEqual({ kind: 'ready' })
  })

  test('M3: скачанный zip испорчен — проверка суммы, zip качается заново', async () => {
    let fail = true
    const s = store({
      extractZip: async (_z, dest) => {
        if (fail) throw new Error('bad zip')
        unzipFake(dest)
      }
    })
    await expect(s.download('whisper-turbo-cuda')).rejects.toMatchObject({ code: 'extract' })
    const zip = join(root, 'whisper-turbo-cuda', 'cuda.zip')
    const broken = readFileSync(zip)
    broken[0] ^= 0xff
    writeFileSync(zip, broken)
    fail = false
    await s.download('whisper-turbo-cuda')
    expect(requests.filter((r) => r.endsWith('/cuda.zip'))).toHaveLength(2)
    expect(await stateOf(s, 'whisper-turbo-cuda')).toEqual({ kind: 'ready' })
  })

  test('M3: отмена во время распаковки — tar остановлен, состояние absent, zip остаётся', async () => {
    let extracting!: () => void
    const started = new Promise<void>((r) => (extracting = r))
    const s = store({
      extractZip: (_z, _dest, signal) =>
        new Promise<void>((_resolve, reject) => {
          extracting()
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })
    })
    const p = s.download('whisper-turbo-cuda')
    await started
    expect(await stateOf(s, 'whisper-turbo-cuda')).toEqual({ kind: 'extracting' })
    s.cancel('whisper-turbo-cuda')
    await expect(p).resolves.toBeUndefined()
    expect(await stateOf(s, 'whisper-turbo-cuda')).toEqual({ kind: 'absent' })
    expect(existsSync(join(root, 'whisper-turbo-cuda', 'cuda.zip'))).toBe(true)
    expect(existsSync(join(root, 'whisper-turbo-cuda', 'cuda'))).toBe(false)
  })

  test('I3: remove сначала отпускает модель (release), пока идёт удаление — paths null', async () => {
    const s = store()
    await s.download('gigaam-v3')
    const order: string[] = []
    let free!: () => void
    const p = s.remove('gigaam-v3', async () => {
      order.push('release')
      expect(s.paths('gigaam-v3')).toBeNull()
      expect(existsSync(join(root, 'gigaam-v3'))).toBe(true)
      await new Promise<void>((r) => (free = r))
      order.push('released')
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['release'])
    expect(existsSync(join(root, 'gigaam-v3'))).toBe(true)
    free()
    await p
    expect(order).toEqual(['release', 'released'])
    expect(existsSync(join(root, 'gigaam-v3'))).toBe(false)
  })

  test('M1: удаление модели, ждущей в очереди, не ждёт чужую загрузку', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = (async (url: string | URL | Request) => {
      if (String(url).endsWith('encoder.int8.onnx') && requests.every((r) => !r.includes('/encoder.int8.onnx'))) await gate
      return fakeFetch(url)
    }) as typeof fetch
    const s = store({ fetch: slow })
    const first = s.download('gigaam-v3')
    const queued = s.download('parakeet-v3')
    await new Promise((r) => setTimeout(r, 30))
    let removed = false
    const rem = s.remove('parakeet-v3').then(() => (removed = true))
    await new Promise((r) => setTimeout(r, 50))
    expect(removed).toBe(true)
    await expect(queued).resolves.toBeUndefined()
    expect(await stateOf(s, 'parakeet-v3')).toEqual({ kind: 'absent' })
    release()
    await Promise.all([first, rem])
    expect(await stateOf(s, 'gigaam-v3')).toEqual({ kind: 'ready' })
    // Отменённая в очереди модель так и не начала качаться и не вернула себе состояние.
    expect(requests.some((r) => r.includes('joiner.int8.onnx'))).toBe(false)
    expect(await stateOf(s, 'parakeet-v3')).toEqual({ kind: 'absent' })
    // И её снова можно поставить в очередь.
    await s.download('parakeet-v3')
    expect(await stateOf(s, 'parakeet-v3')).toEqual({ kind: 'ready' })
  })

  test('M2: удаление последней готовой модели не уносит VAD, пока качается другая', async () => {
    const s0 = store()
    await s0.download('gigaam-v3')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = (async (url: string | URL | Request) => {
      if (String(url).endsWith('joiner.int8.onnx')) await gate
      return fakeFetch(url)
    }) as typeof fetch
    const s = store({ fetch: slow })
    const p = s.download('parakeet-v3')
    await new Promise((r) => setTimeout(r, 30))
    await s.remove('gigaam-v3')
    expect(existsSync(join(root, 'silero-vad', 'silero_vad.onnx'))).toBe(true)
    release()
    await p
    expect(s.paths('parakeet-v3')).not.toBeNull()
  })

  test('I4: Whisper без Visual C++ Redistributable — недоступен, причина и ссылка-действие', async () => {
    const s = store({ vcRuntime: () => false })
    const w = (await s.snapshot()).find((v) => v.id === 'whisper-turbo-cuda')!
    expect(w.available).toBe(false)
    expect(w.unavailableReason).toBe(
      'Для Whisper нужен Microsoft Visual C++ Redistributable (x64). Установите его с сайта Microsoft и перезапустите Qclod.'
    )
    expect(w.fix).toBe('vc-redist')
    await expect(s.download('whisper-turbo-cuda')).rejects.toThrow('Visual C++')
    expect(requests).toEqual([])
    // Без NVIDIA причина — видеокарта, а не VC++.
    const noGpu = store({ vcRuntime: () => false, nvidia: async () => ({ ok: false, reason: 'Нужна видеокарта NVIDIA' }) })
    const v = (await noGpu.snapshot()).find((x) => x.id === 'whisper-turbo-cuda')!
    expect(v.unavailableReason).toBe('Нужна видеокарта NVIDIA')
    expect(v.fix).toBeUndefined()
    // GigaAM от VC++ не зависит.
    expect((await s.snapshot()).find((x) => x.id === 'gigaam-v3')!.available).toBe(true)
  })

  test('M4: нет доступа к папке моделей — русский текст с путём, а не «Нет связи»', async () => {
    const s = store({
      freeBytes: async () => {
        throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${root}'`), { code: 'EPERM' })
      }
    })
    await expect(s.download('gigaam-v3')).rejects.toThrow()
    expect(await stateOf(s, 'gigaam-v3')).toEqual({ kind: 'error', message: `Нет доступа к папке моделей: ${root}` })
  })

  test('удаление GigaAM оставляет VAD, если готов Parakeet; последняя модель уносит VAD', async () => {
    const s = store()
    await s.download('gigaam-v3')
    await s.download('parakeet-v3')
    await s.remove('gigaam-v3')
    expect(existsSync(join(root, 'gigaam-v3'))).toBe(false)
    expect(existsSync(join(root, 'silero-vad', 'silero_vad.onnx'))).toBe(true)
    expect(s.paths('parakeet-v3')).not.toBeNull()
    await s.remove('parakeet-v3')
    expect(existsSync(join(root, 'silero-vad'))).toBe(false)
  })

  test('Whisper без NVIDIA — available false с причиной; download отказывает', async () => {
    const s = store({ nvidia: async () => ({ ok: false, reason: 'Нужна видеокарта NVIDIA' }) })
    const w = (await s.snapshot()).find((v) => v.id === 'whisper-turbo-cuda')!
    expect(w.available).toBe(false)
    expect(w.unavailableReason).toBe('Нужна видеокарта NVIDIA')
    await expect(s.download('whisper-turbo-cuda')).rejects.toThrow('Нужна видеокарта NVIDIA')
    expect(requests).toEqual([])
    const mac = store({ platform: 'darwin' })
    expect((await mac.snapshot()).find((v) => v.id === 'whisper-turbo-cuda')!.unavailableReason).toBe('Пока только на Windows')
  })

  test('onChange не чаще 5 раз в секунду при частом прогрессе', async () => {
    vi.useFakeTimers()
    const cb = vi.fn()
    const chunky = (async (url: string | URL | Request) => {
      const body = bodies.get(String(url).split('/').pop()!)!
      const parts = Array.from({ length: 50 }, (_, i) => new Uint8Array(body.subarray(Math.floor((i * body.length) / 50), Math.floor(((i + 1) * body.length) / 50))))
      return new Response(
        new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p)
            c.close()
          }
        }),
        { status: 200 }
      )
    }) as typeof fetch
    const s2 = store({ fetch: chunky })
    s2.onChange(cb)
    const done = s2.download('gigaam-v3')
    await vi.advanceTimersByTimeAsync(5000)
    await done
    // hundreds of progress ticks, but never more than one notification per 200 ms
    expect(cb.mock.calls.length).toBeGreaterThan(0)
    expect(cb.mock.calls.length).toBeLessThanOrEqual(Math.ceil(5000 / 200) + 2)
  })

  test('отмена: .part остаётся, состояние возвращается в absent, промис не падает', async () => {
    let started!: () => void
    const go = new Promise<void>((r) => (started = r))
    const hang = (async (_url: string | URL | Request, init?: RequestInit) => {
      started()
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))))
    }) as typeof fetch
    const s = store({ fetch: hang })
    const p = s.download('gigaam-v3')
    await go
    s.cancel('gigaam-v3')
    await expect(p).resolves.toBeUndefined()
    expect(await stateOf(s, 'gigaam-v3')).toEqual({ kind: 'absent' })
  })

  test('QCLOD_FAKE_VOICE_MANIFEST подменяет манифест', async () => {
    const s = store()
    await s.download('gigaam-v3')
    expect(readFileSync(join(root, 'gigaam-v3', 'installed.json'), 'utf8')).toContain('"version":1')
    expect(requests.every((r) => r.startsWith('http://x/'))).toBe(true)
  })
})

describe('formatSize', () => {
  test('МБ до 1000, дальше ГБ с одной запятой', () => {
    expect(formatSize(232_000_000)).toBe('232 МБ')
    expect(formatSize(1_300_000_000)).toBe('1,3 ГБ')
  })
})
