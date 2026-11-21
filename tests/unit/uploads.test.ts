import { afterEach, describe, expect, test } from 'vitest'
import { openSync, closeSync, ftruncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REMOTE_INDEX_TTL_MS, RemoteIndexCache, UPLOAD_CHUNK, UPLOAD_MAX, uploadFile } from '../../src/main/ssh/uploads'
import type { RelayReader } from '../../src/main/ssh/remoteFiles'
import { cleanTemps, tempDir } from './relayHarness'

afterEach(cleanTemps)

function recorder(): { client: RelayReader; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  const client: RelayReader = {
    call: async <T,>(_m: string, p: unknown): Promise<T> => {
      calls.push(p as Record<string, unknown>)
      return { path: '/home/u/.qclod/uploads/s1/1-data.bin' } as T
    }
  }
  return { client, calls }
}

describe('загрузка файла на сервер', () => {
  test('600 КиБ — 3 чанка, последний с final; путь из ответа', async () => {
    const file = join(tempDir('qclod-up-'), 'data.bin')
    const bytes = Buffer.alloc(600 * 1024, 7)
    writeFileSync(file, bytes)
    const { client, calls } = recorder()
    const progress: number[] = []
    const path = await uploadFile(client, 's1', file, (sent) => progress.push(sent))
    expect(path).toBe('/home/u/.qclod/uploads/s1/1-data.bin')
    expect(calls.map((c) => [c['offset'], c['final']])).toEqual([
      [0, false],
      [UPLOAD_CHUNK, false],
      [2 * UPLOAD_CHUNK, true]
    ])
    expect(calls.every((c) => c['s'] === 's1' && c['name'] === 'data.bin')).toBe(true)
    // the first chunk names the file on the server; the others go to that very file
    expect(calls[0]!['path']).toBeUndefined()
    expect(calls.slice(1).map((c) => c['path'])).toEqual([
      '/home/u/.qclod/uploads/s1/1-data.bin',
      '/home/u/.qclod/uploads/s1/1-data.bin'
    ])
    const sent = Buffer.concat(calls.map((c) => Buffer.from(c['dataBase64'] as string, 'base64')))
    expect(sent.equals(bytes)).toBe(true)
    expect(progress.at(-1)).toBe(bytes.length)
  })

  test('101 МБ — ошибка без запросов', async () => {
    const file = join(tempDir('qclod-up-'), 'big.bin')
    const fd = openSync(file, 'w')
    ftruncateSync(fd, UPLOAD_MAX + 1024 * 1024)
    closeSync(fd)
    const { client, calls } = recorder()
    await expect(uploadFile(client, 's1', file)).rejects.toThrow('Файл больше 100 МБ — на сервер не загружается')
    expect(calls).toEqual([])
  })

  test('пустой файл — один чанк с final', async () => {
    const file = join(tempDir('qclod-up-'), 'empty.txt')
    writeFileSync(file, '')
    const { client, calls } = recorder()
    await uploadFile(client, 's1', file)
    expect(calls.map((c) => [c['offset'], c['final'], c['dataBase64']])).toEqual([[0, true, '']])
  })
})

describe('@-список серверного чата', () => {
  test('fs.index с limit, кеш на вкладку 60 с', async () => {
    let now = 1000
    const cache = new RelayIndexProbe()
    const index = new RemoteIndexCache(() => now)
    expect(await index.files(async () => cache.client, 't1', '/srv/app', 8000)).toEqual(['a.ts'])
    now += REMOTE_INDEX_TTL_MS - 1
    await index.files(async () => cache.client, 't1', '/srv/app', 8000)
    expect(cache.calls).toEqual([['fs.index', { root: '/srv/app', limit: 8000 }]])
    now += 1
    await index.files(async () => cache.client, 't1', '/srv/app', 8000)
    expect(cache.calls).toHaveLength(2)
  })
})

class RelayIndexProbe {
  readonly calls: Array<[string, unknown]> = []
  readonly client: RelayReader = {
    call: async <T,>(m: string, p: unknown): Promise<T> => {
      this.calls.push([m, p])
      return { files: ['a.ts'], truncated: false } as T
    }
  }
}
