import { plural } from '../../shared/format'
import { toolCategory, type ToolCategory } from '../../shared/toolCategory'
import type { RibbonItem } from '../../shared/types'

export type RowModel =
  | { kind: 'item'; id: string; item: RibbonItem }
  | {
      kind: 'toolGroup'
      id: string
      category: ToolCategory
      /** The calls, with the thinking and answered permissions between them, in order. */
      items: RibbonItem[]
      /** Calls only. */
      count: number
      running: boolean
      errors: number
    }

/** Only these fold; an agent or a plan is always a line of its own. */
const GROUPED: ReadonlySet<ToolCategory> = new Set<ToolCategory>(['read', 'search', 'edit', 'command', 'mcp'])

type Call = Extract<RibbonItem, { kind: 'tool' | 'toolError' }>

function isCall(item: RibbonItem): item is Call {
  return item.kind === 'tool' || item.kind === 'toolError'
}

function groupCategory(item: RibbonItem): ToolCategory | null {
  if (!isCall(item)) return null
  const category = toolCategory(item.name)
  return GROUPED.has(category) ? category : null
}

/** A permission already answered: a line that rides along inside a run, like thinking. */
function isAnsweredPermission(item: RibbonItem): boolean {
  return item.kind === 'permission' && item.state !== 'pending'
}

/**
 * The ribbon's rows: two or more calls of one kind in a row fold into one
 * group. Thinking and answered permissions between them do not break it (they
 * show inside it), anything else does. A card that is open is not a row at all.
 */
export function groupRows(rows: RibbonItem[], isOpen: (item: RibbonItem) => boolean): RowModel[] {
  const out: RowModel[] = []
  let category: ToolCategory | null = null
  let run: RibbonItem[] = []
  /** Answered permissions seen before a call that may start a run. */
  let lead: RibbonItem[] = []

  const single = (item: RibbonItem): RowModel => ({ kind: 'item', id: item.id, item })
  const emitLead = (): void => {
    for (const item of lead) out.push(single(item))
    lead = []
  }

  const flush = (): void => {
    if (category === null) return
    // What trails the last call belongs to what follows, not to the group; the
    // permissions among it may be the lead of the next run.
    let end = run.length
    while (end > 0 && (run[end - 1]!.kind === 'thinking' || isAnsweredPermission(run[end - 1]!))) end--
    // The suffix made only of answered permissions can lead the next run.
    let suffix = run.length
    while (suffix > end && isAnsweredPermission(run[suffix - 1]!)) suffix--
    const body = run.slice(0, end)
    const calls = body.filter(isCall)
    if (calls.length >= 2) {
      out.push({
        kind: 'toolGroup',
        id: `group:${body[0]!.id}`,
        category,
        items: body,
        count: calls.length,
        running: calls.some((c) => c.kind === 'tool' && c.state === 'running'),
        errors: calls.filter((c) => c.kind === 'toolError').length
      })
    } else {
      for (const item of body) out.push(single(item))
    }
    for (const item of run.slice(end, suffix)) out.push(single(item))
    lead = run.slice(suffix)
    category = null
    run = []
  }

  for (const item of rows) {
    if (isOpen(item)) continue
    const own = groupCategory(item)
    if (own !== null) {
      if (category !== own) flush()
      if (category === null) {
        run = lead
        lead = []
      }
      category = own
      run.push(item)
    } else if (category !== null && (item.kind === 'thinking' || isAnsweredPermission(item))) {
      run.push(item)
    } else if (category === null && isAnsweredPermission(item)) {
      lead.push(item)
    } else {
      flush()
      emitLead()
      out.push(single(item))
    }
  }
  flush()
  emitLead()
  return out
}

/** «Прочитал 12 файлов» when done, «Читает файлы: 3» while it runs; errors are a tail. */
export function groupLabel(category: ToolCategory, count: number, running: boolean, errors = 0): string {
  const tail = errors > 0 ? ` · ${errors} ${plural(errors, 'ошибка', 'ошибки', 'ошибок')}` : ''
  return `${base(category, count, running)}${tail}`
}

function base(category: ToolCategory, count: number, running: boolean): string {
  const calls = `${count} ${plural(count, 'вызов', 'вызова', 'вызовов')}`
  switch (category) {
    case 'read':
      return running ? `Читает файлы: ${count}` : `Прочитал ${count} ${plural(count, 'файл', 'файла', 'файлов')}`
    case 'search':
      return running ? `Ищет: ${count}` : `Искал ${count} ${plural(count, 'раз', 'раза', 'раз')}`
    case 'edit':
      return running ? `Правит файлы: ${count}` : `Изменил ${count} ${plural(count, 'файл', 'файла', 'файлов')}`
    case 'command':
      return running ? `Выполняет команды: ${count}` : `Выполнил ${count} ${plural(count, 'команду', 'команды', 'команд')}`
    case 'mcp':
      return `MCP: ${calls}`
    default:
      return `Инструменты: ${calls}`
  }
}
