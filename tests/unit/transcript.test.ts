import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  claudeConfigDir,
  findTranscript,
  loadTranscript,
  readTranscript
} from '../../src/main/agent/transcript'
import { encodeProjectDir, resumedSession, writeTranscript } from '../fixtures/transcript.mjs'

type Message = Record<string, unknown>

const sessionId = '0f0e0d0c-0b0a-4908-8706-050403020100'
const cwd = 'C:\\Users\\u\\proj'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-transcript-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeSession(configDir = tempDir()): { configDir: string; path: string } {
  const session = resumedSession(sessionId, cwd)
  const path = writeTranscript(configDir, cwd, sessionId, session.lines, session.subagents)
  return { configDir, path }
}

function text(message: Message): string {
  const content = (message['message'] as { content: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  return (Array.isArray(content) ? (content as Message[]) : [])
    .map((b) => (typeof b['text'] === 'string' ? b['text'] : typeof b['content'] === 'string' ? b['content'] : ''))
    .join('\n')
}

function toolUses(message: Message): Message[] {
  const content = (message['message'] as { content: unknown } | undefined)?.content
  return (Array.isArray(content) ? (content as Message[]) : []).filter((b) => b['type'] === 'tool_use')
}

async function read(): Promise<Message[]> {
  const { path } = writeSession()
  return (await readTranscript(path)) as Message[]
}

describe('transcript: где лежит файл', () => {
  test('путь ищется по cwd, а при промахе — во всех папках проектов', () => {
    const { configDir, path } = writeSession()
    expect(findTranscript(sessionId, cwd, configDir)).toBe(path)

    // A long cwd gets a hashed folder name from the CLI: the name no longer
    // matches, but the file is still found by its session id.
    const projects = join(configDir, 'projects')
    const moved = join(projects, 'C--Users-u-pr-1a2b3c')
    renameSync(join(projects, encodeProjectDir(cwd)), moved)
    expect(findTranscript(sessionId, cwd, configDir)).toBe(join(moved, `${sessionId}.jsonl`))

    expect(findTranscript('11111111-1111-4111-8111-111111111111', cwd, configDir)).toBeNull()
    // An id that tries to climb out of the projects folder finds nothing.
    expect(findTranscript('..\\..\\secret', cwd, configDir)).toBeNull()
  })

  test('CLAUDE_CONFIG_DIR важнее домашней папки', () => {
    const home = 'C:\\Users\\u'
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: 'D:\\cfg' }, home)).toBe('D:\\cfg')
    expect(claudeConfigDir({}, home)).toBe(join(home, '.claude'))
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, home)).toBe(join(home, '.claude'))
  })

  test('loadTranscript читает из CLAUDE_CONFIG_DIR, а не из home', async () => {
    const { configDir } = writeSession()
    const elsewhere = tempDir()
    const messages = (await loadTranscript(sessionId, cwd, { CLAUDE_CONFIG_DIR: configDir }, elsewhere)) as Message[]
    expect(text(messages[0]!)).toBe('найди, где падает вставка')
    // With the variable unset, the home folder (empty here) is where it looks.
    expect(await loadTranscript(sessionId, cwd, {}, elsewhere)).toEqual([])
  })
})

describe('transcript: что из него читается', () => {
  test('история до сжатия тоже читается, сжатие стоит между ними', async () => {
    const messages = await read()
    const main = messages.filter((m) => m['parent_tool_use_id'] === null || m['type'] === 'system')

    expect(main[0]).toMatchObject({ type: 'user', parent_tool_use_id: null })
    expect(text(main[0]!)).toBe('найди, где падает вставка')
    expect(main[0]!['origin']).toEqual({ kind: 'human' })

    const at = main.findIndex((m) => m['subtype'] === 'compact_boundary')
    expect(at).toBeGreaterThan(0)
    expect(main[at]).toEqual({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 20000 }
    })
    // The question and the foreground agent come before it, the summary right after.
    const before = main.slice(0, at)
    expect(before.some((m) => text(m) === 'смотрю')).toBe(true)
    expect(before.some((m) => toolUses(m).some((b) => (b['input'] as Message)['description'] === 'Обзор вставки'))).toBe(
      true
    )
    expect(main[at + 1]).toMatchObject({ type: 'user', isCompactSummary: true })
    expect(text(main[at + 1]!).startsWith('This session is being continued')).toBe(true)
    expect(text(main.at(-1)!)).toBe('жду подагентов')
  })

  test('toolUseResult доходит как tool_use_result', async () => {
    const messages = await read()
    const explore = messages.find(
      (m) => (m['tool_use_result'] as Message | undefined)?.['status'] === 'completed'
    )!
    expect(explore['tool_use_result']).toMatchObject({ totalTokens: 18000, agentType: 'Explore' })
    expect(explore).not.toHaveProperty('toolUseResult')

    const failed = messages.find((m) => text(m).includes("Agent type 'builder' not found"))!
    expect(failed['tool_use_result']).toBe(
      "Error: Agent type 'builder' not found. Available agents: general-purpose, Explore"
    )
    // A plain prompt has none.
    expect(messages[0]).not.toHaveProperty('tool_use_result')
  })

  test('шаги подагента приходят с parent_tool_use_id его вызова', async () => {
    const messages = await read()
    const callOf = (description: string): { at: number; id: string } => {
      const at = messages.findIndex((m) =>
        toolUses(m).some((b) => (b['input'] as Message)['description'] === description)
      )
      return { at, id: String(toolUses(messages[at]!)[0]!['id']) }
    }

    const explore = callOf('Обзор вставки')
    const steps = messages.filter((m) => m['parent_tool_use_id'] === explore.id)
    // Its prompt, the Read call, the Read result, the final text.
    expect(steps.map((m) => m['type'])).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(toolUses(steps[1]!)[0]).toMatchObject({ name: 'Read' })
    expect(text(steps[3]!)).toBe('Вставка падает в onPaste: пустой clipboardData.')
    // Right after the call, before the call's own result.
    expect(messages.slice(explore.at + 1, explore.at + 1 + steps.length)).toEqual(steps)
    expect(messages[explore.at + 1 + steps.length]!['tool_use_result']).toMatchObject({ status: 'completed' })

    const tests = callOf('Прогон тестов')
    const testSteps = messages.filter((m) => m['parent_tool_use_id'] === tests.id)
    expect(testSteps).toHaveLength(4)
    expect(toolUses(testSteps[1]!)[0]).toMatchObject({ name: 'Bash' })

    const long = callOf('Долгий обзор')
    expect(messages.filter((m) => m['parent_tool_use_id'] === long.id).map(text)).toEqual([
      'Долгий обзор',
      'Начинаю обзор модуля вставки.'
    ])

    // The failed one never ran, so it has no steps.
    const build = callOf('Сборка')
    expect(messages.filter((m) => m['parent_tool_use_id'] === build.id)).toEqual([])
  })

  test('agentId берётся из meta.json, если ответа на вызов нет', async () => {
    const configDir = tempDir()
    const session = resumedSession(sessionId, cwd)
    // Drop the launch receipt of «Долгий обзор»: only its meta.json still ties it to the call.
    const lines = (session.lines as Message[]).filter(
      (l) => (l['toolUseResult'] as Message | undefined)?.['description'] !== 'Долгий обзор'
    )
    const beforeNotice = lines.slice(0, lines.findIndex((l) => l['type'] === 'queue-operation'))
    const path = writeTranscript(configDir, cwd, sessionId, beforeNotice, session.subagents)
    const messages = (await readTranscript(path)) as Message[]
    const call = messages.find((m) =>
      toolUses(m).some((b) => (b['input'] as Message)['description'] === 'Долгий обзор')
    )!
    const id = String(toolUses(call)[0]!['id'])
    expect(messages.filter((m) => m['parent_tool_use_id'] === id).map(text)).toEqual([
      'Долгий обзор',
      'Начинаю обзор модуля вставки.'
    ])
  })

  test('уведомление из queued_command становится сообщением task-notification', async () => {
    const messages = await read()
    const notices = messages.filter(
      (m) => (m['origin'] as Message | undefined)?.['kind'] === 'task-notification'
    )
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ type: 'user', message: { role: 'user' } })
    expect(text(notices[0]!)).toContain('<summary>Agent "Прогон тестов" finished</summary>')
    expect(text(notices[0]!)).toContain('<tool-use-id>toolu_01TestsRun8bQf2Lx9Kd3Vw7</tool-use-id>')
  })

  test('набранное во время работы агента приходит один раз, на своём месте', async () => {
    const messages = await read()
    const typed = messages.filter((m) => text(m) === 'и ещё глянь логи')
    expect(typed).toEqual([
      expect.objectContaining({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'и ещё глянь логи' } })
    ])
    const at = messages.indexOf(typed[0]!)
    const notice = messages.findIndex((m) => (m['origin'] as Message | undefined)?.['kind'] === 'task-notification')
    expect(at).toBeGreaterThan(notice)
    expect(text(messages[at + 1]!)).toBe('жду подагентов')
  })

  test('очередь: текст и картинка массивом, уведомление массивом, дубль в строке user', async () => {
    const configDir = tempDir()
    const base = { isSidechain: false, sessionId, cwd }
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    const notice =
      '<task-notification>\n<task-id>a9</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n' +
      '<status>completed</status>\n<summary>done</summary>\n</task-notification>'
    const queued = (uuid: string, parentUuid: string | null, prompt: unknown): Message => ({
      ...base,
      type: 'attachment',
      uuid,
      parentUuid,
      attachment: { type: 'queued_command', prompt, commandMode: 'prompt', timestamp: 'x' }
    })
    const path = writeTranscript(configDir, cwd, sessionId, [
      queued('a', null, [{ type: 'text', text: 'посмотри картинку' }, image]),
      queued('b', 'a', [{ type: 'text', text: notice }]),
      queued('c', 'b', 'повтор'),
      // Should a CLI ever write the same prompt again as the next user line, it is shown once.
      { ...base, type: 'user', uuid: 'd', parentUuid: 'c', message: { role: 'user', content: 'повтор' } }
    ])
    const messages = (await readTranscript(path)) as Message[]
    expect(messages).toEqual([
      {
        type: 'user',
        uuid: 'a',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'посмотри картинку' }, image] }
      },
      {
        type: 'user',
        origin: { kind: 'task-notification' },
        parent_tool_use_id: null,
        message: { role: 'user', content: notice }
      },
      { type: 'user', uuid: 'd', parent_tool_use_id: null, message: { role: 'user', content: 'повтор' } }
    ])
  })

  test('ветка, отрезанная перемоткой, в историю не попадает', async () => {
    const messages = await read()
    expect(messages.some((m) => text(m) === 'старый вариант')).toBe(false)
    expect(messages.some((m) => text(m) === 'смотрю')).toBe(true)
  })

  test('битая строка и служебные типы пропускаются', async () => {
    const configDir = tempDir()
    const session = resumedSession(sessionId, cwd)
    const path = writeTranscript(configDir, cwd, sessionId, session.lines, session.subagents)
    const raw = readFileSync(path, 'utf8').split('\n')
    raw.splice(3, 0, '{"type":"user","message":{"role":"user","content":"оборвано')
    writeFileSync(path, raw.join('\n'))

    const messages = (await readTranscript(path)) as Message[]
    expect(text(messages[0]!)).toBe('найди, где падает вставка')
    const types = new Set(messages.map((m) => m['type']))
    expect([...types].sort()).toEqual(['assistant', 'system', 'user'])
    // Every system line left is the compaction; turn_duration and the like never get through.
    expect(messages.filter((m) => m['type'] === 'system').map((m) => m['subtype'])).toEqual(['compact_boundary'])
    expect(messages.some((m) => text(m) === 'оборвано')).toBe(false)
  })

  test('прочие system-строки и вложения пропускаются', async () => {
    const configDir = tempDir()
    const base = { isSidechain: false, sessionId, cwd }
    const path = writeTranscript(configDir, cwd, sessionId, [
      { ...base, type: 'user', uuid: 'a', parentUuid: null, message: { role: 'user', content: 'привет' } },
      { ...base, type: 'system', subtype: 'turn_duration', uuid: 'b', parentUuid: 'a', durationMs: 5 },
      { ...base, type: 'attachment', uuid: 'c', parentUuid: 'b', attachment: { type: 'date', date: 'x' } },
      {
        ...base,
        type: 'attachment',
        uuid: 'd',
        parentUuid: 'c',
        attachment: { type: 'queued_command', prompt: 'ещё вопрос', commandMode: 'prompt' }
      },
      {
        ...base,
        type: 'user',
        uuid: 'e',
        parentUuid: 'd',
        isMeta: true,
        message: { role: 'user', content: 'скрытое' }
      },
      { type: 'ai-title', aiTitle: 'x', sessionId },
      { type: 'mode', mode: 'normal', sessionId }
    ])
    const messages = (await readTranscript(path)) as Message[]
    expect(messages).toEqual([
      { type: 'user', uuid: 'a', parent_tool_use_id: null, message: { role: 'user', content: 'привет' } },
      // A prompt typed mid-turn is the person's own message, not a service line.
      { type: 'user', uuid: 'd', parent_tool_use_id: null, message: { role: 'user', content: 'ещё вопрос' } },
      {
        type: 'user',
        uuid: 'e',
        parent_tool_use_id: null,
        isMeta: true,
        message: { role: 'user', content: 'скрытое' }
      }
    ])
  })

  test('чтение не меняет файл', async () => {
    const { configDir, path } = writeSession()
    const subagent = join(configDir, 'projects', encodeProjectDir(cwd), sessionId, 'subagents')
    const files = [path, join(subagent, 'agent-a1c4e7b2d9f0a3b56.jsonl')]
    const before = files.map((f) => ({ body: readFileSync(f, 'utf8'), mtime: statSync(f).mtimeMs }))

    await readTranscript(path)
    await loadTranscript(sessionId, cwd, { CLAUDE_CONFIG_DIR: configDir }, configDir)

    const after = files.map((f) => ({ body: readFileSync(f, 'utf8'), mtime: statSync(f).mtimeMs }))
    expect(after).toEqual(before)
  })

  test('нет файла — пустой список, без исключения', async () => {
    const configDir = tempDir()
    await expect(loadTranscript(sessionId, cwd, { CLAUDE_CONFIG_DIR: configDir }, configDir)).resolves.toEqual([])
    // A folder where the file should be is unreadable as a file: still empty.
    mkdirSync(join(configDir, 'projects', encodeProjectDir(cwd), `${sessionId}.jsonl`), { recursive: true })
    await expect(loadTranscript(sessionId, cwd, { CLAUDE_CONFIG_DIR: configDir }, configDir)).resolves.toEqual([])
    await expect(readTranscript(join(configDir, 'нет.jsonl'))).rejects.toThrow()
  })
})
