import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyState, loadState, pruneClosed, pruneUploads, saveState, type RelayState } from '../../src/relay/stateStore'

const DAY = 24 * 60 * 60 * 1000
const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-state-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function session(s: string, extra: Partial<RelayState['sessions'][number]> = {}): RelayState['sessions'][number] {
  return {
    s,
    cwd: '/home/u/app',
    title: 'Чат',
    sdkSessionId: null,
    mode: 'default',
    remoteControl: false,
    wasRunning: false,
    createdAt: 1,
    ...extra
  }
}

describe('состояние посредника', () => {
  test('круг save → load', () => {
    const path = join(tempDir(), 'state.json')
    const state: RelayState = {
      sessions: [
        session('a1', { sdkSessionId: 'sid', mode: 'autoAllow', model: 'opus', remoteControl: true, wasRunning: true }),
        session('b2', { closedAt: 50 })
      ],
      rules: [{ id: 'r1', toolName: 'Bash', target: 'ls', behavior: 'allow' }],
      autoAnswerMs: 120_000
    }
    saveState(path, state)
    expect(loadState(path)).toEqual(state)
    expect(existsSync(path + '.tmp')).toBe(false)
  })

  test('нет файла — пустое состояние', () => {
    expect(loadState(join(tempDir(), 'state.json'))).toEqual(emptyState())
  })

  test('битый JSON даёт пустое состояние и файл .bad', () => {
    const path = join(tempDir(), 'state.json')
    writeFileSync(path, '{"sessions": [')
    expect(loadState(path)).toEqual(emptyState())
    expect(readFileSync(path + '.bad', 'utf8')).toBe('{"sessions": [')
  })

  test('чужие записи отбрасываются, опасный id сессии тоже', () => {
    const path = join(tempDir(), 'state.json')
    writeFileSync(
      path,
      JSON.stringify({
        sessions: [session('ok'), session('../../etc'), { s: 'x' }, 5],
        rules: [{ id: 'r', toolName: 'Bash', behavior: 'maybe' }],
        autoAnswerMs: -1
      })
    )
    const state = loadState(path)
    expect(state.sessions.map((s) => s.s)).toEqual(['ok'])
    expect(state.rules).toEqual([])
    expect(state.autoAnswerMs).toBe(emptyState().autoAnswerMs)
  })

  test('pruneClosed: 31 день назад — вон с папкой, 29 — остаётся', () => {
    const sessions = tempDir()
    for (const s of ['old', 'young', 'open']) {
      mkdirSync(join(sessions, s))
      writeFileSync(join(sessions, s, 'journal.jsonl'), '')
    }
    const now = 100 * DAY
    const state: RelayState = {
      sessions: [session('old', { closedAt: now - 31 * DAY }), session('young', { closedAt: now - 29 * DAY }), session('open')],
      rules: [],
      autoAnswerMs: 1
    }
    const pruned = pruneClosed(state, sessions, now)
    expect(pruned.sessions.map((s) => s.s)).toEqual(['young', 'open'])
    expect(existsSync(join(sessions, 'old'))).toBe(false)
    expect(existsSync(join(sessions, 'young'))).toBe(true)
    expect(existsSync(join(sessions, 'open'))).toBe(true)
  })

  test('pruneClosed уносит и uploads/<s>; pruneUploads — папки без открытой сессии', () => {
    const root = tempDir()
    const sessions = join(root, 'sessions')
    const uploads = join(root, 'uploads')
    for (const s of ['old', 'open', 'stray']) {
      mkdirSync(join(sessions, s), { recursive: true })
      mkdirSync(join(uploads, s), { recursive: true })
      writeFileSync(join(uploads, s, '1-a.txt'), 'x')
    }
    const now = 100 * DAY
    const state: RelayState = { sessions: [session('old', { closedAt: now - 31 * DAY }), session('open')], rules: [], autoAnswerMs: 1 }
    pruneClosed(state, sessions, now, uploads)
    expect(existsSync(join(uploads, 'old'))).toBe(false)
    expect(existsSync(join(uploads, 'stray'))).toBe(true)
    pruneUploads(uploads, new Set(['open']))
    expect(existsSync(join(uploads, 'stray'))).toBe(false)
    expect(existsSync(join(uploads, 'open', '1-a.txt'))).toBe(true)
    // no uploads folder at all: nothing to do, nothing thrown
    expect(() => pruneUploads(join(root, 'нет'), new Set())).not.toThrow()
  })
})
