/**
 * Finds the places in an agent's text that look like file paths.
 *
 * Only a guess: main checks each candidate against the disk before anything
 * becomes a link, so a false positive costs one stat, while a miss costs the
 * user a path they cannot open. The rules still drop what is plainly not a
 * path (URLs, dates, versions, fractions) and never offer a network path —
 * looking one up would hand the user's NTLM hash to whatever server it names.
 */

export interface PathCandidate {
  /** What stands in the text, line suffix included: `src/a.ts:3`. */
  text: string
  start: number
  end: number
  /** The path alone: `src/a.ts`. */
  path: string
  line?: number
  column?: number
}

/** Rule 1: an absolute Windows path. Stops at whitespace and characters no path holds. */
const ABSOLUTE = /[A-Za-z]:[\\/][^\s"'<>|*?`]*/g
/** Rule 2: the text cut at whitespace and the punctuation that wraps paths in prose. */
const TOKEN = /[^\s()[\]{}<>,;"'«»`]+/g
/** A bare file name with an extension: `README.md`, `план.md`. */
const NAME_WITH_EXT = /^[\p{L}\p{N}_.-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/u
const TRAILING = /[.,:;!?)]+$/
const LINE_SUFFIX = /:(\d+)(?::(\d+))?$/
const INLINE_CODE = /`([^`\n]+)`/g
const DRIVE_START = /^[A-Za-z]:[\\/]/
/** A drive letter glued to these is part of something else: `abC:\`, `\\?\C:\`, `file:///C:/`. */
const GLUED_BEFORE = /[\p{L}\p{N}_\\/?.:$-]/u
/** Never in a Windows path. */
const FORBIDDEN = /["<>|*?]/
const SHELLISH = /[&|;<>$=]/

/** `src/a.ts:3:7` → `{ path: 'src/a.ts', line: 3, column: 7 }`. */
export function splitLineSuffix(text: string): { path: string; line?: number; column?: number } {
  const m = LINE_SUFFIX.exec(text)
  if (!m || m.index === 0) return { path: text }
  const out: { path: string; line?: number; column?: number } = {
    path: text.slice(0, m.index),
    line: Number(m[1])
  }
  if (m[2] !== undefined) out.column = Number(m[2])
  return out
}

/** Trailing punctuation off, then the line suffix split away. */
function shape(raw: string, start: number): PathCandidate | null {
  const text = raw.replace(TRAILING, '')
  if (text === '') return null
  const { path, line, column } = splitLineSuffix(text)
  if (path === '') return null
  const c: PathCandidate = { text, start, end: start + text.length, path }
  if (line !== undefined) c.line = line
  if (column !== undefined) c.column = column
  return c
}

/** Rule 3: what is never a path, whatever rule found it. */
function rejected(c: PathCandidate): boolean {
  const p = c.path
  if (c.text.includes('://')) return true
  if (p.startsWith('//') || p.startsWith('\\\\')) return true
  if (/^[\d./\\]+$/.test(p)) return true
  const segments = p.split(/[\\/]/)
  // A leading separator (`/usr`) and a trailing one (`dir\`) are fine; one in the middle is not.
  for (let i = 1; i < segments.length - 1; i++) if (segments[i] === '') return true
  return false
}

function hasSeparator(s: string): boolean {
  return s.includes('/') || s.includes('\\')
}

/** Rule 2 for one relative token: a separator or a file name with an extension. */
function relativeLooksLikePath(path: string): boolean {
  // A colon in a relative path is a stream name or the tail of something
  // glued to a drive letter; a real absolute path is rule 1's.
  if (path.includes(':') || FORBIDDEN.test(path)) return false
  return hasSeparator(path) || NAME_WITH_EXT.test(path)
}

/**
 * Rule 5: inline code is taken whole when it is a path, spaces and all —
 * that is how an agent quotes `C:\Мои проекты\план 1.md`.
 *
 * A relative span with spaces is taken only when it reads as one path (a
 * folder first, a file name last, no options or shell syntax); otherwise
 * `node scripts/run.mjs` would hide the path inside it.
 */
function inlineCandidate(inner: string, start: number): PathCandidate | null {
  if (inner !== inner.trim()) return null
  const c = shape(inner, start)
  if (!c || rejected(c)) return null
  if (DRIVE_START.test(c.path)) {
    return /[\n"'<>|*?`]/.test(c.path.slice(2)) ? null : c
  }
  if (!/\s/.test(c.path)) return relativeLooksLikePath(c.path) ? c : null
  const words = c.path.split(/\s+/)
  if (!hasSeparator(words[0]!) || words.some((w) => w.startsWith('-'))) return null
  if (SHELLISH.test(c.path) || !relativeLooksLikePath(c.path)) return null
  const last = c.path.split(/[\\/]/).pop()!
  return NAME_WITH_EXT.test(last) ? c : null
}

export function findPathCandidates(text: string): PathCandidate[] {
  const found: PathCandidate[] = []
  /** Inline network paths: claimed so no piece of one becomes a link, never offered. */
  const masked: Array<{ start: number; end: number }> = []
  const overlaps = (start: number, end: number): boolean =>
    found.some((c) => start < c.end && c.start < end) ||
    masked.some((c) => start < c.end && c.start < end)

  // Inline code first, so the spans it claims are masked from the rules
  // below — no partial `C:\Мои` out of `C:\Мои проекты\…`.
  for (const m of text.matchAll(INLINE_CODE)) {
    const inner = m[1]!
    const start = m.index + 1
    const c = inlineCandidate(inner, start)
    if (c) found.push(c)
    else if (/^\s*(\\\\|\/\/)/.test(inner)) masked.push({ start, end: start + inner.length })
  }

  for (const m of text.matchAll(ABSOLUTE)) {
    const before = m.index > 0 ? text[m.index - 1]! : ''
    if (before !== '' && GLUED_BEFORE.test(before)) continue
    const c = shape(m[0], m.index)
    if (!c || rejected(c) || overlaps(c.start, c.end)) continue
    found.push(c)
  }

  for (const m of text.matchAll(TOKEN)) {
    if (overlaps(m.index, m.index + m[0].length)) continue
    const c = shape(m[0], m.index)
    if (!c || rejected(c) || !relativeLooksLikePath(c.path)) continue
    found.push(c)
  }

  return found.sort((a, b) => a.start - b.start)
}
