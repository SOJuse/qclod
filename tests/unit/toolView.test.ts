import { describe, expect, test } from 'vitest'
import { toolOutcome, toolView, type ToolCardItem } from '../../src/shared/toolView'

type ToolItem = Extract<ToolCardItem, { kind: 'tool' }>
type ErrorItem = Extract<ToolCardItem, { kind: 'toolError' }>

function tool(
  name: string,
  input: Record<string, unknown>,
  output: unknown,
  extra: Partial<ToolItem> = {}
): ToolCardItem {
  return {
    kind: 'tool',
    id: 'i1',
    toolUseId: 't1',
    name,
    target: '',
    summary: '',
    detail: '',
    state: 'done',
    input,
    ...(output === undefined ? {} : { output }),
    ...extra
  }
}

function failed(
  name: string,
  input: Record<string, unknown>,
  error: string,
  extra: Partial<ErrorItem> = {}
): ToolCardItem {
  return { kind: 'toolError', id: 'i2', toolUseId: 't2', name, target: '', error, input, ...extra }
}

describe('toolView', () => {
  test('Bash: stdout и stderr раздельно, описание из входа', () => {
    const v = toolView(
      tool('Bash', { command: 'npm test', description: 'Run tests' }, { stdout: 'ok', stderr: 'warn', interrupted: false })
    )
    expect(v).toMatchObject({
      type: 'command',
      command: 'npm test',
      description: 'Run tests',
      stdout: 'ok',
      stderr: 'warn',
      interrupted: false
    })
  })

  test('Bash: фоновая задача и пометка о коде возврата', () => {
    const item = tool(
      'Bash',
      { command: 'npm run dev', run_in_background: true },
      { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1', returnCodeInterpretation: 'ничего страшного' }
    )
    expect(toolView(item)).toMatchObject({ backgroundTaskId: 'b1', note: 'ничего страшного' })
    expect(toolOutcome(item, toolView(item))).toBe('в фоне')
  })

  test('Edit: дифф из structuredPatch и счёт строк', () => {
    const item = tool(
      'Edit',
      { file_path: 'C:\\p\\a.ts' },
      {
        filePath: 'C:\\p\\a.ts',
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }]
      }
    )
    const v = toolView(item)
    expect(v).toMatchObject({
      type: 'edit',
      path: 'C:\\p\\a.ts',
      added: 2,
      removed: 1,
      hunks: [{ oldStart: 1, newStart: 1, lines: [' a', '-b', '+c', '+d'] }]
    })
    expect(toolOutcome(item, v)).toBe('+2 −1')
  })

  test('Edit без output — из old_string/new_string', () => {
    const item = tool('Edit', { file_path: 'a.ts', old_string: 'x\ny', new_string: 'z' }, undefined)
    const v = toolView(item)
    expect(v).toMatchObject({ type: 'edit', path: 'a.ts', added: 1, removed: 2 })
    expect(v.type === 'edit' && v.hunks[0]!.lines).toEqual(['-x', '-y', '+z'])
  })

  test('Write: новый файл — голова и счёт', () => {
    const content = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
    const item = tool('Write', { file_path: 'n.ts', content }, { type: 'create', filePath: 'n.ts', content, structuredPatch: [] })
    const v = toolView(item)
    expect(v).toMatchObject({ type: 'write', created: true, totalLines: 40, size: content.length, added: 40, removed: 0 })
    expect(v.type === 'write' && v.head.length).toBeGreaterThan(0)
    expect(toolOutcome(item, v)).toBe('новый · 40 строк')
  })

  test('Write: перезапись — дифф', () => {
    const item = tool(
      'Write',
      { file_path: 'n.ts', content: 'b' },
      {
        type: 'update',
        filePath: 'n.ts',
        content: 'b',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
      }
    )
    const v = toolView(item)
    expect(v).toMatchObject({ type: 'write', created: false, added: 1, removed: 1 })
    expect(toolOutcome(item, v)).toBe('+1 −1')
  })

  test('Write без output — из content', () => {
    const v = toolView(tool('Write', { file_path: 'n.ts', content: 'a\nb' }, undefined))
    expect(v).toMatchObject({ type: 'write', totalLines: 2, added: 2, removed: 0 })
  })

  test('Read: диапазон строк и превью', () => {
    const item = tool(
      'Read',
      { file_path: 'a.ts', offset: 10, limit: 120 },
      { type: 'text', file: { filePath: 'a.ts', content: 'one\ntwo', numLines: 120, startLine: 10, totalLines: 300 } }
    )
    const v = toolView(item)
    expect(v).toMatchObject({ type: 'read', path: 'a.ts', startLine: 10, numLines: 120, totalLines: 300, preview: ['one', 'two'] })
    expect(toolOutcome(item, v)).toBe('строки 10–129 из 300')
  })

  test('Read целиком: «120 строк»', () => {
    const item = tool(
      'Read',
      { file_path: 'a.ts' },
      { type: 'text', file: { filePath: 'a.ts', content: 'x', numLines: 120, startLine: 1, totalLines: 120 } }
    )
    expect(toolOutcome(item, toolView(item))).toBe('120 строк')
  })

  test('Grep: совпадения и файлы', () => {
    const content = tool('Grep', { pattern: 'foo', path: 'src' }, { mode: 'content', numFiles: 3, filenames: ['a', 'b', 'c'], content: 'a:1:foo', numMatches: 42 })
    const v = toolView(content)
    expect(v).toMatchObject({ type: 'search', pattern: 'foo', where: 'src', content: 'a:1:foo', count: 42, unit: 'matches' })
    expect(toolOutcome(content, v)).toBe('42 совпадения')

    const files = tool('Grep', { pattern: 'foo' }, { mode: 'files_with_matches', numFiles: 17, filenames: ['a'] })
    expect(toolView(files)).toMatchObject({ unit: 'files', count: 17, files: ['a'] })
    expect(toolOutcome(files, toolView(files))).toBe('17 файлов')
  })

  test('Glob: файлы', () => {
    const item = tool('Glob', { pattern: '**/*.ts' }, { numFiles: 1, filenames: ['a.ts'], truncated: false })
    expect(toolView(item)).toMatchObject({ type: 'search', unit: 'files', count: 1, files: ['a.ts'] })
    expect(toolOutcome(item, toolView(item))).toBe('1 файл')
  })

  test('WebSearch: заголовки результатов', () => {
    const item = tool(
      'WebSearch',
      { query: 'vitest' },
      {
        query: 'vitest',
        results: ['текст', { tool_use_id: 'x', content: [{ title: 'Vitest', url: 'https://vitest.dev' }, { title: 'Doc', url: 'https://d' }] }]
      }
    )
    const v = toolView(item)
    expect(v).toMatchObject({ type: 'web', query: 'vitest', results: [{ title: 'Vitest', url: 'https://vitest.dev' }, { title: 'Doc', url: 'https://d' }] })
    expect(toolOutcome(item, v)).toBe('2 результата')
  })

  test('WebFetch: код и размер', () => {
    const item = tool('WebFetch', { url: 'https://a' }, { url: 'https://a', code: 200, codeText: 'OK', bytes: 12 * 1024, result: 'тело', durationMs: 5 })
    const v = toolView(item)
    expect(v).toMatchObject({ type: 'web', url: 'https://a', status: '200', text: 'тело' })
    expect(toolOutcome(item, v)).toBe('200 · 12 КБ')
  })

  test('MCP: сервер, инструмент, аргументы таблицей', () => {
    const item = tool('mcp__gh__create_issue', { title: 'Баг', labels: ['a'] }, undefined, { detail: 'создано' })
    const v = toolView(item)
    expect(v).toMatchObject({
      type: 'mcp',
      server: 'gh',
      tool: 'create_issue',
      args: [{ key: 'title', value: 'Баг' }, { key: 'labels', value: '["a"]' }],
      result: 'создано'
    })
    expect(toolOutcome(item, v)).toBe('готово')
  })

  test('прочее — generic с текстом результата', () => {
    const item = tool('NotebookEdit', {}, undefined, { detail: 'сделано' })
    const v = toolView(item)
    expect(v).toEqual({ type: 'generic', text: 'сделано' })
    expect(toolOutcome(item, v)).toBe('готово')
  })

  test('команда с ошибкой: «ошибка · 1,2 с»', () => {
    const item = failed('Bash', { command: 'false' }, 'Exit code 1', {
      durationMs: 1200,
      output: { stdout: '', stderr: 'boom', interrupted: false }
    })
    const v = toolView(item)
    expect(v).toMatchObject({ type: 'command', stderr: 'boom' })
    expect(toolOutcome(item, v)).toBe('ошибка · 1,2 с')
  })

  test('ошибка без структурного выхода — текст ошибки', () => {
    const item = failed('Read', { file_path: 'x' }, 'нет файла')
    const v = toolView(item)
    expect(v).toEqual({ type: 'generic', text: 'нет файла' })
    expect(toolOutcome(item, v)).toBe('ошибка')
  })

  test('успешная команда: «готово · 1,2 с», прервано без времени', () => {
    const ok = tool('Bash', { command: 'ls' }, { stdout: 'a', stderr: '', interrupted: false }, { durationMs: 1200 })
    expect(toolOutcome(ok, toolView(ok))).toBe('готово · 1,2 с')
    const stopped = tool('Bash', { command: 'ls' }, { stdout: '', stderr: '', interrupted: true }, { durationMs: 5000 })
    expect(toolOutcome(stopped, toolView(stopped))).toBe('прервано')
  })

  test('время короче 100 мс не печатается', () => {
    const fast = tool('Bash', { command: 'ls' }, { stdout: 'a', stderr: '', interrupted: false }, { durationMs: 99 })
    expect(toolOutcome(fast, toolView(fast))).toBe('готово')
    const edge = tool('Bash', { command: 'ls' }, { stdout: 'a', stderr: '', interrupted: false }, { durationMs: 100 })
    expect(toolOutcome(edge, toolView(edge))).toBe('готово · 0,1 с')
  })
})

describe('toolView: усечённые данные и ошибки', () => {
  test('счёт нового файла берётся из скаляров, а не из обрезанного текста', () => {
    const item = tool('Write', { file_path: 'big.ts' }, {
      type: 'create',
      filePath: 'big.ts',
      content: 'x\ny',
      structuredPatch: [],
      _counts: { size: 100_000, totalLines: 5000, added: 5000, removed: 0 }
    })
    expect(toolView(item)).toMatchObject({ type: 'write', size: 100_000, totalLines: 5000, added: 5000 })
    expect(toolOutcome(item, toolView(item))).toBe('новый · 5000 строк')
  })

  test('счёт правки берётся из скаляров', () => {
    const item = tool('Edit', { file_path: 'a.ts' }, {
      filePath: 'a.ts',
      structuredPatch: [{ oldStart: 1, newStart: 1, lines: ['+a'] }],
      _counts: { added: 900, removed: 700 }
    })
    expect(toolOutcome(item, toolView(item))).toBe('+900 −700')
  })

  test('неудавшаяся правка без output не выглядит применённой', () => {
    const item = failed('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, 'String not found')
    expect(toolView(item)).toEqual({ type: 'generic', text: 'String not found' })
  })

  test('неудавшаяся запись без output — текст ошибки', () => {
    const item = failed('Write', { file_path: 'a.ts', content: 'z' }, 'denied')
    expect(toolView(item)).toEqual({ type: 'generic', text: 'denied' })
  })
})
