import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as realFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Every fs call that could open a file, with its flags — the read-only guard. */
const opened = vi.hoisted(() => [] as Array<{ fn: string; path: string; flags: string }>)
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const flagsOf = (o: unknown, fallback: string): string =>
    typeof o === 'object' && o !== null && 'flags' in o ? String((o as { flags: unknown }).flags) : fallback
  return {
    ...real,
    open: (path: string, flags: unknown, ...rest: unknown[]) => {
      opened.push({ fn: 'open', path: String(path), flags: typeof flags === 'string' ? flags : 'r' })
      return (real.open as (...a: unknown[]) => void)(path, flags, ...rest)
    },
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
    },
    writeFile: (path: string, ...rest: unknown[]) => {
      opened.push({ fn: 'writeFile', path: String(path), flags: 'w' })
      return (real.writeFile as (...a: unknown[]) => void)(path, ...rest)
    },
    writeFileSync: (path: string, ...rest: unknown[]) => {
      opened.push({ fn: 'writeFileSync', path: String(path), flags: 'w' })
      return (real.writeFileSync as (...a: unknown[]) => void)(path, ...rest)
    },
    appendFileSync: (path: string, ...rest: unknown[]) => {
      opened.push({ fn: 'appendFileSync', path: String(path), flags: 'a' })
      return (real.appendFileSync as (...a: unknown[]) => void)(path, ...rest)
    }
  }
})

import { MAX_LINE_CHARS, listSessionFiles, readTranscriptTexts, type TranscriptMeta, type TranscriptText } from '@main/history/transcriptText'
import { resumedSession, writeTranscript } from '../fixtures/transcript.mjs'

let configDir: string
beforeEach(() => {
  configDir = realFs.mkdtempSync(join(tmpdir(), 'qclod-transcript-text-'))
})
afterEach(() => realFs.rmSync(configDir, { recursive: true, force: true }))

async function readAll(path: string): Promise<{ texts: TranscriptText[]; meta: TranscriptMeta | null }> {
  const texts: TranscriptText[] = []
  let meta: TranscriptMeta | null = null
  for await (const t of readTranscriptTexts(path, (m) => (meta = m))) texts.push(t)
  return { texts, meta }
}

describe('readTranscriptTexts', () => {
  test('тексты человека и ответы; без tool_result, сабагентов, isMeta и <command-name>', async () => {
    const session = resumedSession('s1', 'C:\\work\\app')
    const extra = [
      { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: служебная строка' }, timestamp: '2026-11-09T11:00:00.000Z' },
      { type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' }, timestamp: '2026-11-09T11:00:01.000Z' },
      { type: 'user', message: { role: 'user', content: '  <local-command-stdout>ok</local-command-stdout>' }, timestamp: '2026-11-09T11:00:02.000Z' },
      {
        type: 'user',
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: 'не человек, а уведомление' },
        timestamp: '2026-11-09T11:00:03.000Z'
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'вот снимок экрана' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
          ]
        },
        timestamp: '2026-11-09T11:00:04.000Z'
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'думаю' }, { type: 'text', text: 'готово' }] },
        timestamp: '2026-11-09T11:00:05.000Z'
      }
    ]
    const path = writeTranscript(configDir, 'C:\\work\\app', 's1', [...session.lines, ...extra], session.subagents)
    const { texts, meta } = await readAll(path)
    const human = texts.filter((t) => t.human).map((t) => t.text)
    expect(human).toEqual([
      'найди, где падает вставка',
      'старый вариант',
      'теперь проверь тесты',
      'и ещё глянь логи',
      'вот снимок экрана'
    ])
    const answers = texts.filter((t) => !t.human)
    expect(answers.every((t) => t.role === 'assistant')).toBe(true)
    expect(answers.map((t) => t.text)).toContain('смотрю')
    expect(answers.map((t) => t.text)).toContain('готово')
    const all = texts.map((t) => t.text).join('\n')
    expect(all).not.toContain('onPaste')
    expect(all).not.toContain('Найди, где падает вставка из буфера')
    expect(all).not.toContain('task-notification')
    expect(all).not.toContain('думаю')
    expect(all).not.toContain('This session is being continued')
    expect(texts.find((t) => t.text === 'найди, где падает вставка')!.at).toBe(Date.parse('2026-11-09T10:00:01.500Z'))
    expect(meta).toEqual({ cwd: 'C:\\work\\app', firstPrompt: 'найди, где падает вставка' })
  })

  test('queued_command с origin.kind: human даёт human: true', async () => {
    const path = writeTranscript(configDir, 'C:\\p', 's2', [
      {
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: 'набрано посреди хода', commandMode: 'prompt', origin: { kind: 'human' } },
        timestamp: '2026-11-09T10:00:00.000Z'
      },
      {
        type: 'attachment',
        attachment: { type: 'queued_command', prompt: 'без origin — не человек', commandMode: 'prompt' },
        timestamp: '2026-11-09T10:00:01.000Z'
      }
    ])
    const { texts } = await readAll(path)
    expect(texts).toEqual([
      { role: 'user', text: 'набрано посреди хода', human: true, at: Date.parse('2026-11-09T10:00:00.000Z') }
    ])
  })

  test('грязная история: длинная строка, битый JSON, недописанный файл', async () => {
    const dir = join(configDir, 'projects', 'C--p')
    realFs.mkdirSync(dir, { recursive: true })
    const path = join(dir, 'dirty.jsonl')
    const huge = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'картинка ' + 'A'.repeat(1_500_000) },
      timestamp: '2026-11-09T10:00:00.000Z'
    })
    expect(huge.length).toBeGreaterThan(MAX_LINE_CHARS)
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'первое сообщение' }, timestamp: '2026-11-09T10:00:00.000Z' }),
      huge,
      '{"type":"user","message":{"role":"us',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ответ' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'второе сообщение' } }),
      // The CLI is writing this one right now: no newline, the JSON cut off.
      '{"type":"user","message":{"role":"user","content":"недопи'
    ]
    realFs.writeFileSync(path, lines.join('\n'))
    const parse = vi.spyOn(JSON, 'parse')
    const { texts } = await readAll(path)
    const longest = Math.max(...parse.mock.calls.map((c) => String(c[0]).length))
    parse.mockRestore()
    expect(texts.map((t) => t.text)).toEqual(['первое сообщение', 'ответ', 'второе сообщение'])
    expect(longest).toBeLessThan(MAX_LINE_CHARS)
  })

  test('ничего не открывается на запись', async () => {
    const session = resumedSession('s3', 'C:\\work\\app')
    writeTranscript(configDir, 'C:\\work\\app', 's3', session.lines, session.subagents)
    opened.length = 0
    const files = await listSessionFiles(configDir)
    for (const f of files) await readAll(f.path)
    expect(files).toHaveLength(1)
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.filter((o) => o.flags !== 'r')).toEqual([])
  })
})
