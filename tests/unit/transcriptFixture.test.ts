import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { encodeProjectDir, resumedSession, writeTranscript } from '../fixtures/transcript.mjs'

type Line = Record<string, unknown>

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-transcript-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readLines(path: string): Line[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
}

/** The chain the CLI resumes: from the last conversation line back by parentUuid. */
function chain(lines: Line[]): Line[] {
  const byUuid = new Map(lines.filter((l) => l['uuid']).map((l) => [l['uuid'], l]))
  const talk = lines.filter(
    (l) => ['user', 'assistant', 'attachment'].includes(String(l['type'])) && l['isSidechain'] !== true
  )
  const out: Line[] = []
  let at: Line | undefined = talk.at(-1)
  while (at) {
    out.push(at)
    const parent = at['parentUuid'] ?? at['logicalParentUuid']
    at = parent ? byUuid.get(parent) : undefined
  }
  return out.reverse()
}

function text(line: Line): string {
  const content = (line['message'] as { content: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<Record<string, unknown>>)
    .map((b) => {
      if (typeof b['text'] === 'string') return b['text']
      if (typeof b['content'] === 'string') return b['content']
      if (Array.isArray(b['content'])) {
        return (b['content'] as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
      }
      return ''
    })
    .join('\n')
}

describe('transcript fixture', () => {
  test('encodeProjectDir заменяет всё, кроме букв и цифр, на дефис', () => {
    expect(encodeProjectDir('C:\\Users\\u\\proj')).toBe('C--Users-u-proj')
    expect(encodeProjectDir('C:/проект/my_app')).toBe('C---------my-app')
  })

  test('writeTranscript кладёт файл туда, где его ищет CLI', () => {
    const dir = tempDir()
    const id = '11111111-2222-4333-8444-555555555555'
    const path = writeTranscript(dir, 'C:\\Users\\u\\proj', id, [{ type: 'user', uuid: 'u1' }], {
      a1234567890abcdef: { meta: { agentType: 'Explore' }, lines: [{ type: 'assistant', uuid: 's1' }] }
    })

    expect(path).toBe(join(dir, 'projects', 'C--Users-u-proj', `${id}.jsonl`))
    expect(readLines(path)).toEqual([{ type: 'user', uuid: 'u1' }])

    const subagents = join(dir, 'projects', 'C--Users-u-proj', id, 'subagents')
    expect(readLines(join(subagents, 'agent-a1234567890abcdef.jsonl'))).toEqual([
      { type: 'assistant', uuid: 's1' }
    ])
    expect(
      JSON.parse(readFileSync(join(subagents, 'agent-a1234567890abcdef.meta.json'), 'utf8'))
    ).toEqual({ agentType: 'Explore' })
  })

  test('без подагентов папка subagents не создаётся', () => {
    const dir = tempDir()
    const path = writeTranscript(dir, 'C:\\p', 'sid', [])
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(dir, 'projects', 'C--p', 'sid'))).toBe(false)
  })
})

describe('resumedSession', () => {
  const sessionId = '0f0e0d0c-0b0a-4908-8706-050403020100'
  const cwd = 'C:\\Users\\u\\proj'
  const session = resumedSession(sessionId, cwd)
  const lines = session.lines as Line[]
  const main = chain(lines)

  test('строки в форме сырого JSONL одной сессии', () => {
    for (const line of lines.filter((l) => l['uuid'])) {
      expect(line['sessionId']).toBe(sessionId)
      expect(line['cwd']).toBe(cwd)
      expect(line).toHaveProperty('parentUuid')
      expect(line).toHaveProperty('isSidechain', false)
    }
    // uuids are unique, so the chain is unambiguous.
    const uuids = lines.filter((l) => l['uuid']).map((l) => l['uuid'])
    expect(new Set(uuids).size).toBe(uuids.length)
  })

  test('цепочка начинается с вопроса и идёт через сжатие до «жду подагентов»', () => {
    expect(main[0]!['type']).toBe('user')
    expect(text(main[0]!)).toBe('найди, где падает вставка')
    expect(main[1]!['type']).toBe('assistant')
    expect((main[1]!['message'] as { model: string }).model).toBe('claude-opus-5')
    expect(text(main[1]!)).toBe('смотрю')

    const last = main.at(-1)!
    expect(last['type']).toBe('assistant')
    expect(text(last)).toBe('жду подагентов')
    expect((last['message'] as { model: string; usage: object }).model).toBe('claude-opus-5')
    expect((last['message'] as { usage: object }).usage).toEqual({
      input_tokens: 12,
      cache_creation_input_tokens: 1400,
      cache_read_input_tokens: 44022,
      output_tokens: 240
    })
  })

  test('сжатие: граница без parentUuid и сводка за ней', () => {
    const at = main.findIndex((l) => l['subtype'] === 'compact_boundary')
    expect(at).toBeGreaterThan(1)
    const boundary = main[at]!
    expect(boundary['parentUuid']).toBeNull()
    expect(boundary['logicalParentUuid']).toBe(main[at - 1]!['uuid'])
    expect(boundary['compactMetadata']).toEqual(
      expect.objectContaining({ trigger: 'auto', preTokens: 180000, postTokens: 20000 })
    )
    const summary = main[at + 1]!
    expect(summary['isCompactSummary']).toBe(true)
    expect(summary['isVisibleInTranscriptOnly']).toBe(true)
    expect(text(summary).startsWith('This session is being continued from a previous conversation')).toBe(
      true
    )
    expect(main.slice(at + 2).some((l) => text(l) === 'теперь проверь тесты')).toBe(true)
  })

  test('подагент Explore на переднем плане: итоги и файл с двумя шагами', () => {
    const result = main.find(
      (l) => (l['toolUseResult'] as Line | undefined)?.['status'] === 'completed'
    )!
    const output = result['toolUseResult'] as Line
    expect(output).toEqual(
      expect.objectContaining({
        totalTokens: 18000,
        totalDurationMs: 42000,
        totalToolUseCount: 7
      })
    )
    const agentId = String(output['agentId'])
    expect(agentId).toMatch(/^a1[0-9a-f]{15}$/)

    const file = session.subagents[agentId]!
    expect(file.meta).toEqual(expect.objectContaining({ agentType: 'Explore', description: 'Обзор вставки' }))
    const steps = (file.lines as Line[]).filter((l) => l['type'] === 'assistant')
    expect(steps).toHaveLength(2)
    const blocks = steps.map((s) => (s['message'] as { content: Line[] }).content[0]!)
    expect(blocks[0]).toEqual(expect.objectContaining({ type: 'tool_use', name: 'Read' }))
    expect(blocks[1]).toEqual(expect.objectContaining({ type: 'text' }))
    for (const line of file.lines as Line[]) {
      expect(line['isSidechain']).toBe(true)
      expect(line['agentId']).toBe(agentId)
    }
    // meta.toolUseId points at the call that launched it.
    const call = main
      .flatMap((l) => {
        const content = (l['message'] as { content: unknown } | undefined)?.content
        return Array.isArray(content) ? (content as Line[]) : []
      })
      .filter((b) => b['type'] === 'tool_use')
      .find((b) => (b['input'] as Line)['description'] === 'Обзор вставки')!
    expect((file.meta as Line)['toolUseId']).toBe(call['id'])
  })

  test('фоновый «Прогон тестов»: запуск, queued_command и уведомление с итогами', () => {
    const launched = main.filter(
      (l) => (l['toolUseResult'] as Line | undefined)?.['status'] === 'async_launched'
    )
    expect(launched).toHaveLength(2)
    const tests = launched[0]!
    const output = tests['toolUseResult'] as Line
    expect(output['isAsync']).toBe(true)
    expect(String(output['agentId'])).toMatch(/^a2[0-9a-f]{15}$/)
    expect(text(tests).startsWith('Async agent launched successfully.')).toBe(true)

    const queued = main.find(
      (l) => l['type'] === 'attachment' && (l['attachment'] as Line)['type'] === 'queued_command'
    )!
    const prompt = String((queued['attachment'] as Line)['prompt'])
    expect(prompt).toContain(`<task-id>${String(output['agentId'])}</task-id>`)
    expect(prompt).toContain('<status>completed</status>')
    expect(prompt).toContain('<summary>Agent "Прогон тестов" finished</summary>')
    expect(prompt).toContain(
      '<usage><subagent_tokens>93175</subagent_tokens><tool_uses>18</tool_uses><duration_ms>110172</duration_ms></usage>'
    )

    // As in the real file: a queued notice is not repeated as a user line.
    expect(main.filter((l) => l['type'] === 'user' && text(l).includes('<task-notification>'))).toEqual([])
    expect(queued['parentUuid']).toBe(launched[1]!['uuid'])
  })

  test('«Сборка» падает, «Долгий обзор» так и не прислал уведомления', () => {
    const failed = main.find((l) => text(l).includes("Agent type 'builder' not found"))!
    const block = (failed['message'] as { content: Line[] }).content[0]!
    expect(block['is_error']).toBe(true)

    const longReview = main.filter(
      (l) => (l['toolUseResult'] as Line | undefined)?.['status'] === 'async_launched'
    )[1]!
    const agentId = String((longReview['toolUseResult'] as Line)['agentId'])
    expect(agentId).toMatch(/^a3[0-9a-f]{15}$/)
    expect(lines.some((l) => JSON.stringify(l).includes(`<task-id>${agentId}</task-id>`))).toBe(false)
  })

  test('ветка, отрезанная перемоткой, в файле есть, а в цепочке — нет', () => {
    const branch = lines.find((l) => text(l) === 'старый вариант')!
    expect(branch['parentUuid']).toBe(main[1]!['uuid'])
    expect(lines.some((l) => l['parentUuid'] === branch['uuid'])).toBe(false)
    expect(main).not.toContain(branch)
  })

  test('служебные строки на месте: их читатель обязан пропускать', () => {
    const types = lines.map((l) => l['type'])
    expect(types).toContain('file-history-snapshot')
    expect(types).toContain('cost-state')
    const enqueue = lines.find((l) => l['type'] === 'queue-operation')!
    expect(enqueue['operation']).toBe('enqueue')
    expect(String(enqueue['content'])).toContain('<summary>Agent "Прогон тестов" finished</summary>')
  })

  test('из resumedSession получается файл, который читается обратно', () => {
    const dir = tempDir()
    const path = writeTranscript(dir, cwd, sessionId, session.lines, session.subagents)
    expect(readLines(path)).toEqual(lines)
    for (const agentId of Object.keys(session.subagents)) {
      expect(
        existsSync(join(dir, 'projects', encodeProjectDir(cwd), sessionId, 'subagents', `agent-${agentId}.jsonl`))
      ).toBe(true)
    }
  })
})
