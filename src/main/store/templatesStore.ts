import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEMPLATE_LIMITS, type PromptTemplate, type TemplateDraft } from '../../shared/types'
import { isTemplateId, sanitizeTemplateDraft } from '../tabs/sanitize'

/** `{ version: 1, templates: PromptTemplate[] }` in userData: the owner's data, not a setting (решение 2). */
export const TEMPLATES_FILE = 'templates.json'

type FileRead =
  | { kind: 'ok'; templates: PromptTemplate[] }
  | { kind: 'missing' }
  /** It is there but could not be read now (locked, no access): not to be overwritten. */
  | { kind: 'unreadable'; reason: string }
  /** Not JSON or not our shape: kept aside as `.bad`. */
  | { kind: 'corrupt' }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** One stored entry, or null when any field is wrong: it is skipped alone. */
function readEntry(value: unknown): PromptTemplate | null {
  if (!isPlainObject(value)) return null
  const { id, title, body, origin, createdAt, updatedAt } = value
  if (!isTemplateId(id) || !isTime(createdAt) || !isTime(updatedAt)) return null
  if (origin !== 'manual' && origin !== 'harvest') return null
  if (typeof title !== 'string' || title.trim() === '') return null
  const draft = sanitizeTemplateDraft({ title, body, origin })
  if (!draft) return null
  return { id, title: draft.title, body: draft.body, origin, createdAt, updatedAt }
}

function readTemplatesFile(file: string): FileRead {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'corrupt' }
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed['templates'])) return { kind: 'corrupt' }
  const seen = new Set<string>()
  const templates: PromptTemplate[] = []
  for (const entry of parsed['templates'] as unknown[]) {
    const t = readEntry(entry)
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    templates.push(t)
    if (templates.length >= TEMPLATE_LIMITS.maxCount) break
  }
  return { kind: 'ok', templates }
}

/** A broken file is kept for the owner, an older `.bad` gives way; false when it could not be moved. */
function setAside(file: string): boolean {
  try {
    renameSync(file, `${file}.bad`)
    return true
  } catch (err) {
    console.warn(`[templates] испорченный ${TEMPLATES_FILE} не отложен:`, err instanceof Error ? err.message : String(err))
    return false
  }
}

function byNewest(list: PromptTemplate[]): PromptTemplate[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * The templates in `dir`, newest first. A file that is not JSON or not of our
 * shape is renamed to `templates.json.bad` and gives an empty list; entries
 * with a wrong field are skipped one by one.
 */
export function loadTemplates(dir: string): PromptTemplate[] {
  const file = join(dir, TEMPLATES_FILE)
  const read = readTemplatesFile(file)
  if (read.kind === 'corrupt') setAside(file)
  return read.kind === 'ok' ? byNewest(read.templates) : []
}

/** The owner's templates, kept in userData/templates.json; every change written at once. */
export class TemplateLibrary {
  private templates: PromptTemplate[]
  /** False when the file is there but could not be read: saving would wipe it. */
  private writable: boolean
  private readonly listeners = new Set<(list: PromptTemplate[]) => void>()
  private readonly now: () => number
  private readonly newId: () => string

  constructor(
    private readonly dir: string,
    deps: { now?: () => number; newId?: () => string } = {}
  ) {
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? randomUUID
    const file = join(dir, TEMPLATES_FILE)
    const read = readTemplatesFile(file)
    this.templates = read.kind === 'ok' ? read.templates : []
    this.writable = read.kind !== 'unreadable'
    if (read.kind === 'unreadable') {
      console.warn(`[templates] ${TEMPLATES_FILE} не читается (${read.reason}); шаблоны в этот раз не сохраняются`)
    } else if (read.kind === 'corrupt') {
      this.writable = setAside(file)
    }
  }

  list(): PromptTemplate[] {
    return byNewest(this.templates)
  }

  /** Updates the template with a known id, else adds one; null when the library is full or the draft is not a template. */
  save(draft: TemplateDraft): PromptTemplate | null {
    const saved = this.put(draft)
    if (saved) this.commit()
    return saved
  }

  /** At most TEMPLATE_LIMITS.saveMany of them, until the library is full; how many were saved. */
  saveMany(drafts: TemplateDraft[]): number {
    let count = 0
    for (const draft of drafts.slice(0, TEMPLATE_LIMITS.saveMany)) {
      if (this.put(draft)) count++
    }
    if (count > 0) this.commit()
    return count
  }

  remove(id: string): boolean {
    const before = this.templates.length
    this.templates = this.templates.filter((t) => t.id !== id)
    if (this.templates.length === before) return false
    this.commit()
    return true
  }

  onChange(cb: (list: PromptTemplate[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Null when the library is full, or the draft is not a template (blank body, too long). */
  private put(raw: TemplateDraft): PromptTemplate | null {
    const draft = sanitizeTemplateDraft(raw)
    if (!draft) return null
    const now = this.now()
    const known = draft.id !== undefined ? this.templates.findIndex((t) => t.id === draft.id) : -1
    if (known >= 0) {
      const prev = this.templates[known]!
      const next: PromptTemplate = {
        ...prev,
        title: draft.title,
        body: draft.body,
        origin: draft.origin ?? prev.origin,
        updatedAt: now
      }
      this.templates[known] = next
      return next
    }
    if (this.templates.length >= TEMPLATE_LIMITS.maxCount) return null
    let id = this.newId()
    while (this.templates.some((t) => t.id === id)) id = this.newId()
    const created: PromptTemplate = {
      id,
      title: draft.title,
      body: draft.body,
      origin: draft.origin ?? 'manual',
      createdAt: now,
      updatedAt: now
    }
    this.templates.push(created)
    return created
  }

  private commit(): void {
    this.write()
    const list = this.list()
    for (const cb of this.listeners) cb(list)
  }

  /** Through `templates.json.tmp` and a rename: a write cut off half-way leaves the old file whole. */
  private write(): void {
    if (!this.writable) return
    const file = join(this.dir, TEMPLATES_FILE)
    const temp = `${file}.tmp`
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(temp, JSON.stringify({ version: 1, templates: this.templates }, null, 2), 'utf8')
      renameSync(temp, file)
    } catch (err) {
      console.warn('[templates]', err instanceof Error ? err.message : String(err))
      try {
        rmSync(temp, { force: true })
      } catch {
        /* the next write replaces it */
      }
    }
  }
}
