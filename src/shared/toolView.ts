import { bytes, lines, plural, seconds } from './format'
import type { RibbonItem } from './types'

/**
 * What a tool card shows when opened, decided from the call's input, its
 * structured output (the SDK's tool_use_result) and its text.
 *
 * Pure, like the rest of shared/: the window only draws what comes out of
 * here. Output shapes are those of sdk-tools.d.ts; a field that is missing —
 * an old stored ribbon, a version that renamed something — gives a plainer
 * view, never an error.
 */

export type ToolCardItem = Extract<RibbonItem, { kind: 'tool' | 'toolError' }>

/** `lines` carry a one-character prefix: ' ' context, '+' added, '-' removed. */
export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: string[]
}

export type ToolView =
  | {
      type: 'command'
      command: string
      description: string
      stdout: string
      stderr: string
      interrupted: boolean
      backgroundTaskId?: string
      note?: string
    }
  | { type: 'edit'; path: string; hunks: DiffHunk[]; added: number; removed: number }
  | {
      type: 'write'
      path: string
      created: boolean
      size: number
      head: string[]
      totalLines: number
      hunks: DiffHunk[]
      added: number
      removed: number
    }
  | {
      type: 'read'
      path: string
      startLine: number
      numLines: number
      totalLines: number
      preview: string[]
    }
  | {
      type: 'search'
      pattern: string
      where: string
      files: string[]
      content: string
      count: number
      unit: 'files' | 'matches' | 'lines'
    }
  | {
      type: 'web'
      url?: string
      query?: string
      status?: string
      results: Array<{ title: string; url: string }>
      text: string
    }
  | {
      type: 'mcp'
      server: string
      tool: string
      args: Array<{ key: string; value: string }>
      result: string
    }
  | { type: 'generic'; text: string }

/** How many lines of a file a card previews. */
const PREVIEW_LINES = 12
/** How many first lines of a written file a card shows. */
const WRITE_HEAD_LINES = 20
/** A call shorter than this prints no time: «0,0 с» reads as noise. */
const MIN_PRINTED_MS = 100

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

function resultText(item: ToolCardItem): string {
  return item.kind === 'tool' ? item.detail : item.error
}

/**
 * Counts the ribbon took before it clipped the output (see clipOutput in
 * ribbon.ts); what is left in the output may be only the start of the file.
 */
function countsOf(output: unknown): Partial<Record<'added' | 'removed' | 'size' | 'totalLines', number>> {
  const counts = isObject(output) ? output['_counts'] : undefined
  if (!isObject(counts)) return {}
  const pick = (key: string): number | undefined => num(counts[key])
  const found: Partial<Record<'added' | 'removed' | 'size' | 'totalLines', number>> = {}
  for (const key of ['added', 'removed', 'size', 'totalLines'] as const) {
    const value = pick(key)
    if (value !== undefined) found[key] = value
  }
  return found
}

function countChanges(hunks: DiffHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

function patchOf(output: unknown): DiffHunk[] | null {
  if (!isObject(output) || !Array.isArray(output['structuredPatch'])) return null
  return output['structuredPatch'].filter(isObject).map((h) => ({
    oldStart: num(h['oldStart']) ?? 1,
    newStart: num(h['newStart']) ?? 1,
    lines: strings(h['lines'])
  }))
}

/** The old record has no patch: the edit is shown whole, old text out and new text in. */
function wholeEdit(oldText: string, newText: string): DiffHunk {
  return {
    oldStart: 1,
    newStart: 1,
    lines: [
      ...splitLines(oldText).map((l) => `-${l}`),
      ...splitLines(newText).map((l) => `+${l}`)
    ]
  }
}

function commandView(input: Obj, output: unknown, fallback: string, failed: boolean): ToolView {
  const out = isObject(output) ? output : null
  const view: Extract<ToolView, { type: 'command' }> = {
    type: 'command',
    command: str(input['command']),
    description: str(input['description']),
    // Without an output the result text is all there is: an old record's
    // output, or a failure's error, which the card already shows on top.
    stdout: out ? str(out['stdout']) : failed ? '' : fallback,
    stderr: out ? str(out['stderr']) : '',
    interrupted: out?.['interrupted'] === true
  }
  const taskId = out ? str(out['backgroundTaskId']) : ''
  if (taskId) view.backgroundTaskId = taskId
  const note = out ? str(out['returnCodeInterpretation']) : ''
  if (note) view.note = note
  return view
}

function editView(input: Obj, output: unknown): ToolView {
  const hunks = patchOf(output) ?? [wholeEdit(str(input['old_string']), str(input['new_string']))]
  const path = (isObject(output) ? str(output['filePath']) : '') || str(input['file_path'])
  const counts = countsOf(output)
  const own = countChanges(hunks)
  return { type: 'edit', path, hunks, added: counts.added ?? own.added, removed: counts.removed ?? own.removed }
}

function writeView(input: Obj, output: unknown): ToolView {
  const out = isObject(output) ? output : null
  const content = (out ? str(out['content']) : '') || str(input['content'])
  const all = splitLines(content)
  const counts = countsOf(output)
  const totalLines = counts.totalLines ?? all.length
  const created = out?.['type'] === 'create'
  let hunks = patchOf(output)
  let { added, removed } = hunks ? countChanges(hunks) : { added: 0, removed: 0 }
  if (created) {
    // A new file has no patch to count: everything in it is added.
    added = totalLines
    removed = 0
  } else if (!hunks) {
    hunks = [{ oldStart: 1, newStart: 1, lines: all.map((l) => `+${l}`) }]
    ;({ added, removed } = countChanges(hunks))
  }
  return {
    type: 'write',
    path: (out ? str(out['filePath']) : '') || str(input['file_path']),
    created,
    size: counts.size ?? content.length,
    head: all.slice(0, WRITE_HEAD_LINES),
    totalLines,
    hunks: hunks ?? [],
    added: counts.added ?? added,
    removed: counts.removed ?? removed
  }
}

function readView(input: Obj, output: unknown): ToolView {
  const file = isObject(output) && isObject(output['file']) ? output['file'] : {}
  const content = str(file['content'])
  const numLines = num(file['numLines']) ?? splitLines(content).length
  return {
    type: 'read',
    path: str(file['filePath']) || str(input['file_path']),
    startLine: num(file['startLine']) ?? 1,
    numLines,
    totalLines: num(file['totalLines']) ?? numLines,
    preview: splitLines(content).slice(0, PREVIEW_LINES)
  }
}

function searchView(name: string, input: Obj, output: Obj): ToolView {
  const files = strings(output['filenames'])
  const base = {
    type: 'search' as const,
    pattern: str(input['pattern']),
    where: str(input['path']) || str(input['glob']),
    files,
    content: str(output['content'])
  }
  const numFiles = num(output['numFiles']) ?? files.length
  if (name === 'Grep') {
    const numMatches = num(output['numMatches'])
    if (numMatches !== undefined) return { ...base, count: numMatches, unit: 'matches' }
    const numLines = num(output['numLines'])
    if (numLines !== undefined) return { ...base, count: numLines, unit: 'lines' }
  }
  return { ...base, count: numFiles, unit: 'files' }
}

function webView(name: string, input: Obj, output: Obj): ToolView {
  if (name === 'WebFetch') {
    const code = num(output['code'])
    return {
      type: 'web',
      url: str(output['url']) || str(input['url']),
      ...(code !== undefined ? { status: String(code) } : {}),
      results: [],
      text: str(output['result'])
    }
  }
  const results: Array<{ title: string; url: string }> = []
  const texts: string[] = []
  for (const entry of Array.isArray(output['results']) ? output['results'] : []) {
    if (typeof entry === 'string') {
      texts.push(entry)
    } else if (isObject(entry)) {
      for (const hit of Array.isArray(entry['content']) ? entry['content'] : []) {
        if (isObject(hit)) results.push({ title: str(hit['title']), url: str(hit['url']) })
      }
    }
  }
  return {
    type: 'web',
    query: str(output['query']) || str(input['query']),
    results,
    text: texts.join('\n')
  }
}

function mcpView(item: ToolCardItem, input: Obj): ToolView {
  const [, server = '', ...rest] = item.name.split('__')
  return {
    type: 'mcp',
    server,
    tool: rest.join('__'),
    args: Object.entries(input).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
    })),
    result: resultText(item)
  }
}

/** The opened card of a tool call. */
export function toolView(item: ToolCardItem): ToolView {
  const input = item.input ?? {}
  const output = item.output
  const failed = item.kind === 'toolError'

  if (item.name.startsWith('mcp__')) return mcpView(item, input)

  switch (item.name) {
    case 'Bash':
      if (isObject(output) || typeof input['command'] === 'string') {
        return commandView(input, output, resultText(item), failed)
      }
      break
    // A failed edit has no output: showing the input as a diff would show a
    // change that never happened.
    case 'Edit':
      if (failed && !isObject(output)) break
      return editView(input, output)
    case 'Write':
      if (failed && !isObject(output)) break
      return writeView(input, output)
    case 'Read':
      if (isObject(output)) return readView(input, output)
      break
    case 'Grep':
    case 'Glob':
      if (isObject(output)) return searchView(item.name, input, output)
      break
    case 'WebFetch':
    case 'WebSearch':
      if (isObject(output)) return webView(item.name, input, output)
      break
    default:
      break
  }
  return { type: 'generic', text: resultText(item) }
}

function withTime(word: string, item: ToolCardItem): string {
  const ms = item.durationMs
  return ms !== undefined && ms >= MIN_PRINTED_MS ? `${word} · ${seconds(ms)}` : word
}

/** The right-hand side of a folded card: what came of the call, in a few words. */
export function toolOutcome(item: ToolCardItem, view: ToolView): string {
  const failed = item.kind === 'toolError'

  switch (view.type) {
    case 'command':
      if (failed) return withTime('ошибка', item)
      if (view.interrupted) return 'прервано'
      if (view.backgroundTaskId) return 'в фоне'
      return withTime('готово', item)

    case 'edit':
      return failed ? 'ошибка' : `+${view.added} −${view.removed}`

    case 'write':
      if (failed) return 'ошибка'
      return view.created ? `новый · ${lines(view.totalLines)}` : `+${view.added} −${view.removed}`

    case 'read': {
      if (failed) return 'ошибка'
      if (view.numLines === 0) return 'готово'
      if (view.numLines < view.totalLines) {
        const last = view.startLine + view.numLines - 1
        return `строки ${view.startLine}–${last} из ${view.totalLines}`
      }
      return lines(view.numLines)
    }

    case 'search': {
      if (failed) return 'ошибка'
      const n = view.count
      if (view.unit === 'files') return `${n} ${plural(n, 'файл', 'файла', 'файлов')}`
      if (view.unit === 'matches') return `${n} ${plural(n, 'совпадение', 'совпадения', 'совпадений')}`
      return lines(n)
    }

    case 'web': {
      if (failed) return 'ошибка'
      if (view.status !== undefined) {
        const size = isObject(item.output) ? num(item.output['bytes']) : undefined
        return size !== undefined ? `${view.status} · ${bytes(size)}` : view.status
      }
      const n = view.results.length
      return n > 0 ? `${n} ${plural(n, 'результат', 'результата', 'результатов')}` : 'готово'
    }

    default:
      return failed ? 'ошибка' : 'готово'
  }
}
