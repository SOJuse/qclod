import { score } from '../../shared/commandFilter'
import { clip } from '../../shared/format'
import type { PromptTemplate } from '../../shared/types'
import type { InlineMenuItem } from '../components/InlineMenu'
import { fold } from '../palette/rank'

/**
 * Prompt templates in the input (решение 1): a template is always put in at
 * the caret, and its first `{{что подставить}}` comes selected — typing
 * replaces it, the way a form field would.
 */

/** A template's row in the `/` list: `tpl:<id>`, so a command of the same name stays itself. */
export const TEMPLATE_ITEM_PREFIX = 'tpl:'

/** How many templates a list shows. */
const TEMPLATE_CAP = 8
/** A body's search covers its start: past it, any letters would fit. */
const BODY_SEARCH = 200
/** A body match ranks below a title match of the same quality. */
const BODY_PENALTY = 50

const PLACE = /\{\{[^{}\n]*\}\}/

export interface InsertResult {
  text: string
  selStart: number
  selEnd: number
}

/** Вставка на место выделения; выделяется первое {{…}} из вставленного, иначе курсор в конец вставки. */
export function insertTemplate(draft: string, selStart: number, selEnd: number, body: string): InsertResult {
  const start = Math.max(0, Math.min(selStart, draft.length))
  const end = Math.max(start, Math.min(selEnd, draft.length))
  const text = draft.slice(0, start) + body + draft.slice(end)
  const place = PLACE.exec(body)
  if (place) return { text, selStart: start + place.index, selEnd: start + place.index + place[0].length }
  return { text, selStart: start + body.length, selEnd: start + body.length }
}

/** Из списка `/`: заменяет «/запрос» (draft.slice(0, caret)) на текст шаблона. */
export function applyTemplateFromSlash(draft: string, caret: number, body: string): InsertResult {
  return insertTemplate(draft, 0, caret, body)
}

/** A body's first line that says something, for a row's second part. */
function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim() !== '') ?? ''
  return clip(line.trim(), 80)
}

function newestFirst(templates: PromptTemplate[]): PromptTemplate[] {
  return [...templates].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The `/` list's templates, after Claude Code's commands: by title, or the newest with nothing typed. */
export function templateItems(templates: PromptTemplate[], query: string): InlineMenuItem[] {
  const needle = fold(query.trim())
  const chosen =
    needle === ''
      ? newestFirst(templates).slice(0, TEMPLATE_CAP)
      : newestFirst(templates)
          .map((t) => ({ t, p: score(fold(t.title), needle) }))
          .filter((e): e is { t: PromptTemplate; p: number } => e.p !== null)
          .sort((a, b) => b.p - a.p)
          .slice(0, TEMPLATE_CAP)
          .map((e) => e.t)
  return chosen.map((t) => {
    const secondary = firstLine(t.body)
    return {
      id: `${TEMPLATE_ITEM_PREFIX}${t.id}`,
      primary: t.title,
      ...(secondary ? { secondary } : {}),
      hint: 'шаблон'
    }
  })
}

export interface TemplateHit {
  id: string
  title: string
  preview: string
  points: number
}

/** Ctrl+K's templates: by title, or by the start of the text a little lower; newest first among equals. */
export function templateHits(templates: PromptTemplate[], query: string, limit = TEMPLATE_CAP): TemplateHit[] {
  const needle = fold(query.trim())
  const hits: TemplateHit[] = []
  for (const t of newestFirst(templates)) {
    let points: number | null = 0
    if (needle !== '') {
      const byTitle = score(fold(t.title), needle)
      const byBody = score(fold(t.body.slice(0, BODY_SEARCH)), needle)
      const fromBody = byBody === null ? null : byBody - BODY_PENALTY
      points = byTitle === null ? fromBody : fromBody === null ? byTitle : Math.max(byTitle, fromBody)
    }
    if (points !== null) hits.push({ id: t.id, title: t.title, preview: firstLine(t.body), points })
  }
  // A stable sort: equals keep the newest-first order.
  return hits.sort((a, b) => b.points - a.points).slice(0, limit)
}
