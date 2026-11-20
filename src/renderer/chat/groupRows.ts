import { plural } from '../../shared/format'
import { toolCategory, type ToolCategory } from '../../shared/toolCategory'
import type { RibbonItem } from '../../shared/types'

export type RowModel =
  | { kind: 'item'; id: string; item: RibbonItem }
  | {
      kind: 'toolGroup'
      id: string
      category: ToolCategory
      /** The calls and the thinking between them, in order. */
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

/**
 * The ribbon's rows: two or more calls of one kind in a row fold into one
 * group; thinking between them does not break it, anything else does. A card
 * that is open is not a row at all.
 */
export function groupRows(rows: RibbonItem[], isOpen: (item: RibbonItem) => boolean): RowModel[] {
  const out: RowModel[] = []
  let category: ToolCategory | null = null
  let run: RibbonItem[] = []

  const single = (item: RibbonItem): RowModel => ({ kind: 'item', id: item.id, item })

  const flush = (): void => {
    if (category !== null && run.length > 0) {
      // Thinking after the last call belongs to what follows, not to the group.
      let end = run.length
      while (end > 0 && run[end - 1]!.kind === 'thinking') end--
      const body = run.slice(0, end)
      const calls = body.filter(isCall)
      if (calls.length >= 2) {
        const last = calls[calls.length - 1]!
        out.push({
          kind: 'toolGroup',
          id: `group:${body[0]!.id}`,
          category,
          items: body,
          count: calls.length,
          running: last.kind === 'tool' && last.state === 'running',
          errors: calls.filter((c) => c.kind === 'toolError').length
        })
      } else {
        for (const item of body) out.push(single(item))
      }
      for (const item of run.slice(end)) out.push(single(item))
    }
    category = null
    run = []
  }

  for (const item of rows) {
    if (isOpen(item)) continue
    const own = groupCategory(item)
    if (own !== null) {
      if (category !== own) flush()
      category = own
      run.push(item)
    } else if (item.kind === 'thinking' && category !== null) {
      run.push(item)
    } else {
      flush()
      out.push(single(item))
    }
  }
  flush()
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
