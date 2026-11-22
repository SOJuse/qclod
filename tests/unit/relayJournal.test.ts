import { afterEach, describe, expect, test } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal, JOURNAL_FILE } from '../../src/relay/journal'
import { relayPaths } from '../../src/relay/paths'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-journal-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('журнал сессии посредника', () => {
  test('номера 1, 2, 3; readAfter(1) даёт 2, 3 без разрыва', () => {
    const dir = join(tempDir(), 's1')
    let t = 100
    const journal = Journal.open(dir, { now: () => t++ })
    expect(journal.firstSeq).toBe(1)
    expect(journal.lastSeq).toBe(0)
    const a = journal.append('sdk', { type: 'system' })
    const b = journal.append('sent', { input: { text: 'привет' } })
    const c = journal.append('notice', { kind: 'text', text: 'x', tone: 'info' })
    expect([a.q, b.q, c.q]).toEqual([1, 2, 3])
    expect(a).toEqual({ q: 1, at: 100, k: 'sdk', d: { type: 'system' } })
    const after = journal.readAfter(1)
    expect(after.gap).toBe(false)
    expect(after.records.map((r) => r.q)).toEqual([2, 3])
    expect(after.records[0]).toEqual(b)
    expect(journal.readAfter(3)).toEqual({ records: [], gap: false })
    expect(journal.readAfter(0).records).toHaveLength(3)
  })

  test('после переполнения firstSeq > 1 и readAfter(0).gap', () => {
    const dir = join(tempDir(), 's1')
    const journal = Journal.open(dir, { maxBytes: 4096 })
    for (let i = 0; i < 200; i++) journal.append('sdk', { i, pad: 'x'.repeat(40) })
    expect(journal.lastSeq).toBe(200)
    expect(journal.firstSeq).toBeGreaterThan(1)
    expect(statSync(join(dir, JOURNAL_FILE)).size).toBeLessThanOrEqual(4096)
    const all = journal.readAfter(0)
    expect(all.gap).toBe(true)
    expect(all.records[0]!.q).toBe(journal.firstSeq)
    expect(all.records.at(-1)!.q).toBe(200)
    // consecutive, nothing lost inside what is kept
    all.records.forEach((r, i) => expect(r.q).toBe(journal.firstSeq + i))
    expect(journal.readAfter(journal.firstSeq - 1).gap).toBe(false)
    expect(journal.readAfter(journal.firstSeq - 2).gap).toBe(true)
  })

  test('открытие заново продолжает с lastSeq + 1', () => {
    const dir = join(tempDir(), 's1')
    const first = Journal.open(dir)
    first.append('sdk', 1)
    first.append('sdk', 2)
    first.close()
    const again = Journal.open(dir)
    expect(again.lastSeq).toBe(2)
    expect(again.append('sdk', 3).q).toBe(3)
    expect(again.readAfter(0).records.map((r) => r.d)).toEqual([1, 2, 3])
  })

  test('обрезанная последняя строка не ломает открытие', () => {
    const dir = join(tempDir(), 's1')
    const first = Journal.open(dir)
    first.append('sdk', { a: 1 })
    first.append('sdk', { a: 2 })
    first.close()
    appendFileSync(join(dir, JOURNAL_FILE), '{"q":3,"at":1,"k":"sdk","d":{"a"')
    const again = Journal.open(dir)
    expect(again.lastSeq).toBe(2)
    expect(again.append('sdk', { a: 3 }).q).toBe(3)
    const lines = readFileSync(join(dir, JOURNAL_FILE), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => JSON.parse(l).q)).toEqual([1, 2, 3])
  })

  test('запись 10 000 строк по 1 КиБ укладывается в 1 с', () => {
    const dir = join(tempDir(), 's1')
    const journal = Journal.open(dir)
    const pad = 'я'.repeat(500)
    const started = performance.now()
    for (let i = 0; i < 10_000; i++) journal.append('sdk', { i, pad })
    const ms = performance.now() - started
    expect(journal.lastSeq).toBe(10_000)
    expect(ms).toBeLessThan(1000)
  })

  test.runIf(process.platform !== 'win32')('папка 0700, файл 0600', () => {
    const dir = join(tempDir(), 's1')
    Journal.open(dir).append('sdk', 1)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, JOURNAL_FILE)).mode & 0o777).toBe(0o600)
  })
})

describe('пути посредника', () => {
  test('корень ~/.qclod, сокет в run/', () => {
    const p = relayPaths('/home/u', 'linux')
    expect(p.root).toBe('/home/u/.qclod')
    expect(p.bin).toBe('/home/u/.qclod/bin')
    expect(p.run).toBe('/home/u/.qclod/run')
    expect(p.socket).toBe('/home/u/.qclod/run/relay.sock')
    expect(p.state).toBe('/home/u/.qclod/state.json')
    expect(p.sessions).toBe('/home/u/.qclod/sessions')
    expect(p.uploads).toBe('/home/u/.qclod/uploads')
    expect(p.logs).toBe('/home/u/.qclod/logs')
    expect(p.lock.startsWith('/home/u/.qclod/run/')).toBe(true)
  })

  test('подменённый корень и именованный канал на win32', () => {
    const a = relayPaths('C:\\Users\\u', 'win32', 'C:\\tmp\\qclod-a')
    const b = relayPaths('C:\\Users\\u', 'win32', 'C:\\tmp\\qclod-b')
    expect(a.root).toBe('C:\\tmp\\qclod-a')
    expect(a.socket).toMatch(/^\\\\\.\\pipe\\qclod-relay-[0-9a-f]+$/)
    expect(a.socket).not.toBe(b.socket)
  })
})
