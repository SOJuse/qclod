import { clip } from '../../shared/format'
import { projectKey } from '../../shared/projects'
import type { HistoryHit } from '../../shared/types'
import { listSessionFiles, readTranscriptTexts, type SessionFile } from './transcriptText'

/**
 * Full-text search over past conversations (решение 7): every session file
 * under `<configDir>/projects`, newest first, the person's messages and
 * Claude's answers. No index on disk — Qclod keeps no copy of the
 * conversations — so it streams, within a time budget, and keeps the texts it
 * read in memory, bounded, for the next keystroke.
 */
export const SEARCH = { minQuery: 3, maxQuery: 200, limit: 30, budgetMs: 1_500, cacheChars: 32_000_000, snippetSide: 60 } as const

/** нижний регистр, ё→е, пробелы схлопнуты */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')
}

interface CachedText {
  role: 'user' | 'assistant'
  /** The text with its whitespace collapsed: what a snippet is cut from. */
  shown: string
  /** `shown` normalized; the same length, so a match's place holds in both. */
  folded: string
}

interface CachedFile {
  mtimeMs: number
  size: number
  texts: CachedText[]
  cwd: string | null
  firstPrompt: string | null
  chars: number
}

/** The same length as its input, unlike toLowerCase() for a few letters; those are compared as they are. */
function foldSameLength(shown: string): string {
  const folded = normalize(shown)
  return folded.length === shown.length ? folded : shown.replace(/ё/g, 'е').replace(/Ё/g, 'Е')
}

export class HistorySearch {
  /** path → texts, oldest use first (a Map keeps insertion order: LRU). */
  private readonly cache = new Map<string, CachedFile>()
  private cachedChars = 0
  /** Bumped by every search: an older one still running stops at its next file. */
  private generation = 0
  /** Folders the last searches found, by projectKey: the window may open a session there. */
  private readonly found = new Set<string>()
  private readonly now: () => number
  private readonly budgetMs: number

  constructor(
    private readonly configDir: string,
    deps: { now?: () => number; budgetMs?: number } = {}
  ) {
    this.now = deps.now ?? Date.now
    this.budgetMs = deps.budgetMs ?? SEARCH.budgetMs
  }

  /** A folder some search found a session in: opening it is opening the owner's own history. */
  knowsFolder(cwd: string): boolean {
    return this.found.has(projectKey(cwd))
  }

  /** Новый вызов отменяет предыдущий: тот отдаёт то, что успел, своё. */
  async search(query: string): Promise<HistoryHit[]> {
    const mine = ++this.generation
    const needle = normalize(query.trim())
    if (needle.length < SEARCH.minQuery || query.length > SEARCH.maxQuery) return []
    const started = this.now()
    const hits: HistoryHit[] = []
    let files: SessionFile[]
    try {
      files = await listSessionFiles(this.configDir)
    } catch {
      return []
    }
    for (const file of files) {
      if (mine !== this.generation) return []
      if (hits.length >= SEARCH.limit || this.now() - started > this.budgetMs) break
      const texts = await this.load(file)
      if (!texts || texts.cwd === null) continue
      const hit = this.match(file, texts, needle)
      if (hit) {
        hits.push(hit)
        this.found.add(projectKey(hit.cwd))
      }
    }
    return mine === this.generation ? hits : []
  }

  private match(file: SessionFile, texts: CachedFile, needle: string): HistoryHit | null {
    for (const t of texts.texts) {
      const at = t.folded.indexOf(needle)
      if (at === -1) continue
      const side = SEARCH.snippetSide
      const from = Math.max(0, at - side)
      const to = Math.min(t.shown.length, at + needle.length + side)
      const head = from > 0 ? '…' : ''
      const tail = to < t.shown.length ? '…' : ''
      const cwd = texts.cwd!
      return {
        sessionId: file.sessionId,
        cwd,
        // Either slash: a Windows project's path read on a Mac is still named by its folder.
        projectLabel: cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd,
        title: clip(texts.firstPrompt ?? 'Без названия', 60),
        snippet: `${head}${t.shown.slice(from, to)}${tail}`,
        matchStart: at - from + head.length,
        matchLength: needle.length,
        role: t.role,
        updatedAt: file.mtimeMs
      }
    }
    return null
  }

  /** The file's texts from memory while it is unchanged, else read again. */
  private async load(file: SessionFile): Promise<CachedFile | null> {
    const cached = this.cache.get(file.path)
    if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
      this.cache.delete(file.path)
      this.cache.set(file.path, cached)
      return cached
    }
    if (cached) this.forget(file.path)
    const entry: CachedFile = { mtimeMs: file.mtimeMs, size: file.size, texts: [], cwd: null, firstPrompt: null, chars: 0 }
    try {
      for await (const t of readTranscriptTexts(file.path, (m) => {
        entry.cwd = m.cwd
        entry.firstPrompt = m.firstPrompt
      })) {
        const shown = t.text.replace(/\s+/g, ' ')
        entry.texts.push({ role: t.role, shown, folded: foldSameLength(shown) })
        entry.chars += shown.length
      }
    } catch {
      return null
    }
    this.cache.set(file.path, entry)
    this.cachedChars += entry.chars
    while (this.cachedChars > SEARCH.cacheChars && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value as string
      this.forget(oldest)
    }
    return entry
  }

  private forget(path: string): void {
    const entry = this.cache.get(path)
    if (!entry) return
    this.cachedChars -= entry.chars
    this.cache.delete(path)
  }
}
