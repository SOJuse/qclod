import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SCAN, scanHumanPrompts } from '@main/templates/promptScan'
import { listSessionFiles } from '@main/history/transcriptText'
import { encodeProjectDir, resumedSession, writeTranscript } from '../fixtures/transcript.mjs'

const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

let configDir: string
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'qclod-prompt-scan-'))
})
afterEach(() => rmSync(configDir, { recursive: true, force: true }))

/** A session of the person's prompts, each answered; its file dated `daysAgo`. */
function session(cwd: string, id: string, prompts: string[], daysAgo = 1): string {
  const at = NOW - daysAgo * DAY
  const lines = prompts.flatMap((text, i) => [
    {
      type: 'user',
      isSidechain: false,
      origin: { kind: 'human' },
      cwd,
      sessionId: id,
      message: { role: 'user', content: text },
      timestamp: new Date(at + i * 1000).toISOString()
    },
    {
      type: 'assistant',
      isSidechain: false,
      cwd,
      sessionId: id,
      message: { role: 'assistant', content: [{ type: 'text', text: `ответ на ${i}` }] },
      timestamp: new Date(at + i * 1000 + 500).toISOString()
    }
  ])
  const path = writeTranscript(configDir, cwd, id, lines)
  utimesSync(path, new Date(at), new Date(at))
  return path
}

describe('scanHumanPrompts', () => {
  test('3 проекта, 5 сессий: счётчики по проектам верны', async () => {
    session('C:\\a', 'a1', ['напиши тесты для модуля А', 'сделай ревью ветки main'], 1)
    session('C:\\a', 'a2', ['объясни, что делает этот файл'], 2)
    session('C:\\b', 'b1', ['почини сборку на windows'], 3)
    session('C:\\b', 'b2', ['обнови зависимости проекта', 'запусти линтер и исправь'], 4)
    session('C:\\c', 'c1', ['переведи README на русский'], 5)

    const scan = await scanHumanPrompts(configDir, { now: NOW })
    expect(scan.sessions).toBe(5)
    expect(scan.truncated).toBe(false)
    expect(scan.items).toHaveLength(7)
    const byKey = Object.fromEntries(scan.projects.map((p) => [p.key, p]))
    expect(byKey[encodeProjectDir('C:\\a')]).toEqual({
      key: encodeProjectDir('C:\\a'),
      label: 'C:\\a',
      sessions: 2,
      prompts: 3,
      chars: 'напиши тесты для модуля А'.length + 'сделай ревью ветки main'.length + 'объясни, что делает этот файл'.length
    })
    expect(byKey[encodeProjectDir('C:\\b')]).toMatchObject({ sessions: 2, prompts: 3 })
    expect(byKey[encodeProjectDir('C:\\c')]).toMatchObject({ sessions: 1, prompts: 1, label: 'C:\\c' })
    // Newest first.
    expect(scan.items[0]!.text).toBe('сделай ревью ветки main')
    expect(scan.items.every((i) => !i.text.startsWith('ответ'))).toBe(true)
  })

  test('файл старше 90 дней не взят', async () => {
    session('C:\\a', 'new', ['свежий запрос к агенту'], 10)
    session('C:\\a', 'old', ['очень старый запрос'], SCAN.sinceDays + 1)
    const scan = await scanHumanPrompts(configDir, { now: NOW })
    expect(scan.items.map((i) => i.text)).toEqual(['свежий запрос к агенту'])
    expect(scan.sessions).toBe(1)
  })

  test('дубль с другим регистром — один, самый свежий', async () => {
    session('C:\\a', 'older', ['Сделай  Ревью Ветки'], 5)
    session('C:\\a', 'newer', ['сделай ревью ветки'], 1)
    const scan = await scanHumanPrompts(configDir, { now: NOW })
    expect(scan.items.map((i) => i.text)).toEqual(['сделай ревью ветки'])
    expect(scan.sessions).toBe(1)
  })

  test('500 сообщений → 400 и truncated: true', async () => {
    const prompts = Array.from({ length: 500 }, (_v, i) => `запрос номер ${i} к агенту`)
    session('C:\\a', 'many', prompts, 1)
    const scan = await scanHumanPrompts(configDir, { now: NOW })
    expect(scan.items).toHaveLength(SCAN.maxPrompts)
    expect(scan.truncated).toBe(true)
    // The newest are the ones kept.
    expect(scan.items[0]!.text).toBe('запрос номер 499 к агенту')
  })

  test('не больше 60 000 символов, длинное обрезано до 2 000', async () => {
    const prompts = Array.from({ length: 40 }, (_v, i) => `${i} `.padEnd(3000, 'я'))
    session('C:\\a', 'long', prompts, 1)
    const scan = await scanHumanPrompts(configDir, { now: NOW })
    expect(scan.items.every((i) => i.text.length === SCAN.perPromptMax)).toBe(true)
    expect(scan.items.reduce((n, i) => n + i.text.length, 0)).toBeLessThanOrEqual(SCAN.maxChars)
    expect(scan.items).toHaveLength(30)
    expect(scan.truncated).toBe(true)
  })

  test('«продолжай» (9 символов) не взят', async () => {
    session('C:\\a', 's', ['продолжай', 'продолжай работу над тестами'], 1)
    const scan = await scanHumanPrompts(configDir, { now: NOW })
    expect(scan.items.map((i) => i.text)).toEqual(['продолжай работу над тестами'])
  })

  test('excluded убирает проект', async () => {
    session('C:\\a', 'a', ['запрос в проекте А'], 1)
    session('C:\\b', 'b', ['запрос в проекте Б'], 1)
    const scan = await scanHumanPrompts(configDir, { now: NOW, excluded: [encodeProjectDir('C:\\a')] })
    expect(scan.projects.map((p) => p.key)).toEqual([encodeProjectDir('C:\\b')])
    expect(scan.items.map((i) => i.text)).toEqual(['запрос в проекте Б'])
  })

  test('нет папки projects — пусто, без ошибки', async () => {
    const scan = await scanHumanPrompts(join(configDir, 'нет'), { now: NOW })
    expect(scan).toEqual({ projects: [], items: [], sessions: 0, truncated: false })
  })
})

describe('listSessionFiles', () => {
  test('не видит <id>/subagents/*.jsonl, новые сверху', async () => {
    const s = resumedSession('main', 'C:\\work')
    writeTranscript(configDir, 'C:\\work', 'main', s.lines, s.subagents)
    session('C:\\work', 'later', ['ещё один разговор тут'], -2)
    const files = await listSessionFiles(configDir)
    expect(files.map((f) => f.sessionId)).toEqual(['later', 'main'])
    expect(files.every((f) => !f.path.includes('subagents'))).toBe(true)
    expect(files[0]).toMatchObject({ projectKey: encodeProjectDir('C:\\work') })
    expect(files[0]!.size).toBeGreaterThan(0)
  })
})
