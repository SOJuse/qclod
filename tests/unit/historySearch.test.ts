import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Every open with its flags, and the reads — the read-only guard and the cache check. */
const opened = vi.hoisted(() => [] as Array<{ fn: string; path: string; flags: string }>)
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const flagsOf = (o: unknown, fallback: string): string =>
    typeof o === 'object' && o !== null && 'flags' in o ? String((o as { flags: unknown }).flags) : fallback
  return {
    ...real,
    openSync: (path: string, flags?: unknown, ...rest: unknown[]) => {
      opened.push({ fn: 'openSync', path: String(path), flags: typeof flags === 'string' ? flags : 'r' })
      return (real.openSync as (...a: unknown[]) => number)(path, flags, ...rest)
    },
    createReadStream: (path: string, o?: unknown) => {
      opened.push({ fn: 'createReadStream', path: String(path), flags: flagsOf(o, 'r') })
      return real.createReadStream(path, o as Parameters<typeof real.createReadStream>[1])
    },
    createWriteStream: (path: string, o?: unknown) => {
      opened.push({ fn: 'createWriteStream', path: String(path), flags: flagsOf(o, 'w') })
      return real.createWriteStream(path, o as Parameters<typeof real.createWriteStream>[1])
    }
  }
})

import { HistorySearch, SEARCH, normalize } from '@main/history/historySearch'
import { historyTextProvider } from '@renderer/palette/historyText'
import { resumedSession, writeTranscript } from '../fixtures/transcript.mjs'

let configDir: string
beforeEach(() => {
  configDir = realFs.mkdtempSync(join(tmpdir(), 'qclod-history-search-'))
})
afterEach(() => realFs.rmSync(configDir, { recursive: true, force: true }))

function session(cwd: string, id: string, turns: Array<[string, string]>, mtime = Date.now()): string {
  const lines = turns.flatMap(([asked, answered], i) => [
    { type: 'user', cwd, origin: { kind: 'human' }, message: { role: 'user', content: asked }, timestamp: new Date(mtime + i).toISOString() },
    { type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text: answered }] }, timestamp: new Date(mtime + i).toISOString() }
  ])
  const path = writeTranscript(configDir, cwd, id, lines)
  realFs.utimesSync(path, new Date(mtime), new Date(mtime))
  return path
}

describe('normalize', () => {
  test('нижний регистр, ё как е, пробелы схлопнуты', () => {
    expect(normalize('  Ёлка\n\tи   ЁЖ ')).toBe(' елка и еж ')
  })
})

describe('HistorySearch', () => {
  test('находит фразу из ответа ассистента и из сообщения человека; заголовок и отрывок', async () => {
    session('C:\\work\\shop', 'a', [['почини оплату картой', 'Оплата падает в модуле checkout: нет ключа.']], Date.now() - 1000)
    session('C:\\work\\blog', 'b', [['напиши статью про оплату', 'готово']], Date.now())
    const search = new HistorySearch(configDir)

    const fromAnswer = await search.search('модуле checkout')
    expect(fromAnswer).toHaveLength(1)
    expect(fromAnswer[0]).toMatchObject({
      sessionId: 'a',
      cwd: 'C:\\work\\shop',
      projectLabel: 'shop',
      title: 'почини оплату картой',
      role: 'assistant'
    })
    const hit = fromAnswer[0]!
    expect(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength).toLowerCase()).toBe('модуле checkout')

    const fromPerson = await search.search('статью про')
    expect(fromPerson.map((h) => [h.sessionId, h.role])).toEqual([['b', 'user']])

    // Newest first, one hit per session.
    expect((await search.search('оплат')).map((h) => h.sessionId)).toEqual(['b', 'a'])
  })

  test('«Ёлка» находится по «елка»', async () => {
    session('C:\\p', 's', [['нарисуй Ёлку на главной', 'нарисовал']])
    const hits = await new HistorySearch(configDir).search('елку')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet.slice(hits[0]!.matchStart, hits[0]!.matchStart + hits[0]!.matchLength)).toBe('Ёлку')
  })

  test('отрывок — по 60 символов с обеих сторон, «…» на обрезах', async () => {
    const before = 'а'.repeat(100)
    const after = 'б'.repeat(100)
    session('C:\\p', 's', [[`${before} иголка ${after}`, 'ок']])
    const [hit] = await new HistorySearch(configDir).search('иголка')
    expect(hit!.snippet).toBe(`…${'а'.repeat(59)} иголка ${'б'.repeat(59)}…`)
    expect(hit!.snippet.slice(hit!.matchStart, hit!.matchStart + hit!.matchLength)).toBe('иголка')
  })

  test('запрос короче 3 символов — пусто', async () => {
    session('C:\\p', 's', [['ab ab ab', 'ok']])
    expect(await new HistorySearch(configDir).search('ab')).toEqual([])
  })

  test('сабагентские тексты не ищутся', async () => {
    const s = resumedSession('main', 'C:\\work')
    writeTranscript(configDir, 'C:\\work', 'main', s.lines, s.subagents)
    const search = new HistorySearch(configDir)
    // Only in a subagent's own file.
    expect(await search.search('упали два теста')).toEqual([])
    expect((await search.search('теперь проверь тесты')).map((h) => h.sessionId)).toEqual(['main'])
  })

  test('второй поиск во время первого: первый не смешивает', async () => {
    for (let i = 0; i < 20; i++) session('C:\\p', `s${i}`, [[`общее слово ${i}`, 'ответ']], Date.now() - i * 1000)
    const search = new HistorySearch(configDir)
    const first = search.search('общее слово')
    const second = search.search('ответ')
    const [a, b] = await Promise.all([first, second])
    expect(a.every((h) => h.snippet.includes('общее'))).toBe(true)
    expect(a.length).toBeLessThan(20)
    expect(b).toHaveLength(20)
    expect(b.every((h) => h.role === 'assistant')).toBe(true)
  })

  test('повторный поиск не читает файл снова, пока не сменился mtime', async () => {
    const path = session('C:\\p', 's', [['искомая фраза здесь', 'ответ']], Date.now() - 5000)
    const search = new HistorySearch(configDir)
    opened.length = 0
    await search.search('искомая')
    await search.search('фраза')
    expect(opened.filter((o) => o.fn === 'createReadStream')).toHaveLength(1)
    realFs.utimesSync(path, new Date(), new Date())
    await search.search('фраза')
    expect(opened.filter((o) => o.fn === 'createReadStream')).toHaveLength(2)
  })

  test('ничего не открывается на запись', async () => {
    const s = resumedSession('main', 'C:\\work')
    writeTranscript(configDir, 'C:\\work', 'main', s.lines, s.subagents)
    session('C:\\p', 's', [['что-то ещё', 'ответ']])
    opened.length = 0
    await new HistorySearch(configDir).search('вставка')
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.filter((o) => o.flags !== 'r')).toEqual([])
  })

  test('budgetMs: 0 — пусто или частично, без ошибки; не больше 30', async () => {
    for (let i = 0; i < 40; i++) session('C:\\p', `s${i}`, [[`слово ${i}`, 'ответ']], Date.now() - i * 1000)
    const hits = await new HistorySearch(configDir, { budgetMs: 0 }).search('слово')
    expect(Array.isArray(hits)).toBe(true)
    expect(hits.length).toBeLessThan(40)
    expect(await new HistorySearch(configDir).search('слово')).toHaveLength(SEARCH.limit)
  })

  test('папка, найденная поиском, известна для открытия', async () => {
    session('C:\\elsewhere', 's', [['найди меня тут', 'ок']])
    const search = new HistorySearch(configDir)
    expect(search.knowsFolder('C:\\elsewhere')).toBe(false)
    await search.search('найди меня')
    expect(search.knowsFolder('c:\\elsewhere')).toBe(true)
  })
})

describe('Ctrl+K «В разговорах»', () => {
  const hit = {
    sessionId: 's1',
    cwd: 'C:\shop',
    projectLabel: 'shop',
    title: 'почини оплату',
    snippet: '…падает в модуле checkout: нет…',
    matchStart: 10,
    matchLength: 6,
    role: 'assistant' as const,
    updatedAt: Date.parse('2026-11-19T10:00:00Z')
  }
  const ctx = (historyText: unknown, openSession = vi.fn()) =>
    ({ historyText, run: { openSession } }) as never

  test('короче 3 символов — нет раздела; пока ищет — «Ищу в разговорах…»', () => {
    expect(historyTextProvider.title).toBe('В разговорах')
    expect(historyTextProvider.items('мо', ctx(null))).toEqual([])
    const waiting = historyTextProvider.items('модуле', ctx({ query: 'модуле', hits: [], pending: true }))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ section: 'historyText', title: 'Ищу в разговорах…', disabled: true })
    // An answer for an older query is not shown for this one.
    expect(historyTextProvider.items('модуле', ctx({ query: 'мод', hits: [hit], pending: false }))[0]!.title).toBe(
      'Ищу в разговорах…'
    )
  })

  test('пункт: «заголовок — отрывок», совпадение отмечено, проект и дата; Enter открывает сессию', () => {
    const openSession = vi.fn()
    const [row] = historyTextProvider.items('модуле', ctx({ query: 'модуле', hits: [hit], pending: false }, openSession))
    expect(row!.title).toBe('почини оплату — …падает в модуле checkout: нет…')
    expect(row!.title.slice(row!.mark!.start, row!.mark!.start + row!.mark!.length)).toBe('модуле')
    expect(row!.hint!.startsWith('shop · ')).toBe(true)
    row!.run()
    expect(openSession).toHaveBeenCalledWith('C:\shop', expect.objectContaining({ id: 's1', title: 'почини оплату' }))
    expect(historyTextProvider.items('модуле', ctx({ query: 'модуле', hits: [], pending: false }))).toEqual([])
  })
})
