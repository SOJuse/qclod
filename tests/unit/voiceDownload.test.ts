import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DownloadError, fetchFile } from '../../src/main/voice/download'
import type { ManifestFile } from '../../src/main/voice/manifest'

const BODY = Buffer.from(Array.from({ length: 50_000 }, (_, i) => (i * 7 + 3) % 256))
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

type Handler = (req: IncomingMessage, res: ServerResponse) => void
let server: Server
let base: string
let handlers: Record<string, Handler>
let ranges: Array<string | undefined>
let tmp: string

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'qclod-dl-'))
  handlers = {}
  ranges = []
  server = createServer((req, res) => {
    ranges.push(req.headers['range'])
    const h = handlers[req.url ?? '']
    if (!h) {
      res.writeHead(404).end()
      return
    }
    h(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  rmSync(tmp, { recursive: true, force: true })
})

/** A good server: honours Range. */
const good =
  (body: Buffer = BODY): Handler =>
  (req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers['range'] ?? '')
    if (m) {
      const from = Number(m[1])
      if (from >= body.length) {
        res.writeHead(416).end()
        return
      }
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` }).end(body.subarray(from))
      return
    }
    res.writeHead(200).end(body)
  }

/** Sends the first `cut` bytes and drops the connection. */
const broken =
  (cut: number): Handler =>
  (_req, res) => {
    res.writeHead(200, { 'Content-Length': BODY.length })
    res.write(BODY.subarray(0, cut))
    setTimeout(() => res.destroy(), 20)
  }

const file = (urls: string[], body: Buffer = BODY): ManifestFile => ({
  name: 'f.bin',
  size: body.length,
  sha256: sha(body),
  urls
})
const deps = (extra: Partial<Parameters<typeof fetchFile>[2]> = {}) => ({
  fetch: globalThis.fetch,
  onBytes: () => {},
  ...extra
})

describe('fetchFile', () => {
  test('скачивает, проверяет SHA-256, .part переименован', async () => {
    handlers['/a'] = good()
    const seen: number[] = []
    await fetchFile(file([`${base}/a`]), tmp, deps({ onBytes: (n) => seen.push(n) }))
    expect(readFileSync(join(tmp, 'f.bin')).equals(BODY)).toBe(true)
    expect(existsSync(join(tmp, 'f.bin.part'))).toBe(false)
    expect(seen.at(-1)).toBe(BODY.length)
  })

  test('обрыв на середине: повтор шлёт Range с размера .part и докачивает', async () => {
    handlers['/a'] = broken(20_000)
    await expect(fetchFile(file([`${base}/a`]), tmp, deps())).rejects.toMatchObject({ code: 'network' })
    const left = statSync(join(tmp, 'f.bin.part')).size
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(BODY.length)
    handlers['/a'] = good()
    ranges.length = 0
    await fetchFile(file([`${base}/a`]), tmp, deps())
    expect(ranges).toEqual([`bytes=${left}-`])
    expect(readFileSync(join(tmp, 'f.bin')).equals(BODY)).toBe(true)
  })

  test('обрыв на основном — зеркало продолжает с того же места', async () => {
    handlers['/a'] = broken(20_000)
    handlers['/m'] = good()
    ranges.length = 0
    await fetchFile(file([`${base}/a`, `${base}/m`]), tmp, deps())
    expect(ranges[0]).toBeUndefined()
    expect(ranges[1]).toMatch(/^bytes=\d+-$/)
    expect(readFileSync(join(tmp, 'f.bin')).equals(BODY)).toBe(true)
  })

  test('сервер отвечает 200 на Range — качает с нуля, сумма верна', async () => {
    writeFileSync(join(tmp, 'f.bin.part'), BODY.subarray(0, 10_000))
    handlers['/a'] = (_req, res) => void res.writeHead(200).end(BODY)
    await fetchFile(file([`${base}/a`]), tmp, deps())
    expect(ranges).toEqual(['bytes=10000-'])
    expect(readFileSync(join(tmp, 'f.bin')).equals(BODY)).toBe(true)
  })

  test('сумма не совпала на основном — файл с нуля с зеркала', async () => {
    const bad = Buffer.from(BODY)
    bad[100] ^= 0xff
    handlers['/a'] = good(bad)
    handlers['/m'] = good()
    ranges.length = 0
    await fetchFile(file([`${base}/a`, `${base}/m`]), tmp, deps())
    expect(ranges[1]).toBeUndefined() // from scratch, no Range
    expect(readFileSync(join(tmp, 'f.bin')).equals(BODY)).toBe(true)
  })

  test('оба источника битые — checksum, .part удалён', async () => {
    const bad = Buffer.from(BODY)
    bad[5] ^= 0xff
    handlers['/a'] = good(bad)
    handlers['/m'] = good(bad)
    const err = await fetchFile(file([`${base}/a`, `${base}/m`]), tmp, deps()).catch((e) => e)
    expect(err).toBeInstanceOf(DownloadError)
    expect(err.code).toBe('checksum')
    expect(existsSync(join(tmp, 'f.bin.part'))).toBe(false)
    expect(existsSync(join(tmp, 'f.bin'))).toBe(false)
  })

  test('основной недоступен — сразу зеркало', async () => {
    handlers['/m'] = good()
    await fetchFile(file([`${base}/missing`, `${base}/m`]), tmp, deps())
    expect(readFileSync(join(tmp, 'f.bin')).equals(BODY)).toBe(true)
  })

  test('полный .part с верной суммой: 416 не мешает', async () => {
    writeFileSync(join(tmp, 'f.bin.part'), BODY)
    handlers['/a'] = good()
    await fetchFile(file([`${base}/a`]), tmp, deps())
    expect(readFileSync(join(tmp, 'f.bin')).equals(BODY)).toBe(true)
  })

  test('M5: сервер замолчал посреди файла — через idleMs не висим, network; .part на месте', async () => {
    handlers['/a'] = (_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length })
      res.write(BODY.subarray(0, 15_000))
      // and nothing more, the connection stays open
    }
    const started = Date.now()
    const err = await fetchFile(file([`${base}/a`]), tmp, deps({ idleMs: 300 })).catch((e) => e)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(err).toBeInstanceOf(DownloadError)
    expect(err.code).toBe('network')
    expect(err.message).toMatch(/no data/)
    expect(statSync(join(tmp, 'f.bin.part')).size).toBe(15_000)
  })

  test('M5: замолчал основной — зеркало докачивает с того же места', async () => {
    handlers['/a'] = (_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length })
      res.write(BODY.subarray(0, 15_000))
    }
    handlers['/m'] = good()
    ranges.length = 0
    await fetchFile(file([`${base}/a`, `${base}/m`]), tmp, deps({ idleMs: 300 }))
    expect(ranges[1]).toBe('bytes=15000-')
    expect(readFileSync(join(tmp, 'f.bin')).equals(BODY)).toBe(true)
  })

  test('M4: .part нельзя писать (EPERM) — access, а не network, зеркало не пробуем', async () => {
    const part = join(tmp, 'f.bin.part')
    writeFileSync(part, BODY.subarray(0, 10_000))
    chmodSync(part, 0o444)
    handlers['/a'] = good()
    handlers['/m'] = good()
    ranges.length = 0
    try {
      const err = await fetchFile(file([`${base}/a`, `${base}/m`]), tmp, deps()).catch((e) => e)
      expect(err).toBeInstanceOf(DownloadError)
      expect(err.code).toBe('access')
      expect(ranges).toHaveLength(1)
    } finally {
      chmodSync(part, 0o666)
    }
  })

  test('отмена — aborted, .part на месте', async () => {
    const ac = new AbortController()
    handlers['/a'] = (_req, res) => {
      res.writeHead(200, { 'Content-Length': BODY.length })
      res.write(BODY.subarray(0, 15_000))
      // never finishes
    }
    const p = fetchFile(file([`${base}/a`]), tmp, deps({ signal: ac.signal, onBytes: (n) => n >= 15_000 && ac.abort() }))
    const err = await p.catch((e) => e)
    expect(err).toBeInstanceOf(DownloadError)
    expect(err.code).toBe('aborted')
    expect(existsSync(join(tmp, 'f.bin.part'))).toBe(true)
    expect(existsSync(join(tmp, 'f.bin'))).toBe(false)
  })
})
