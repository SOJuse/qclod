import { findPathCandidates, type PathCandidate } from '../../shared/pathCandidates'
import type { ResolvedPath } from '../../shared/types'

export type LinkPiece = string | { text: string; target: ResolvedPath }

/**
 * The candidates in a piece of text. Text inside inline code is read as
 * inline code, so `C:\Мои проекты\план.md` stays one path, spaces and all.
 */
function candidatesIn(text: string, code: boolean): PathCandidate[] {
  if (!code || text.includes('`')) return findPathCandidates(text)
  return findPathCandidates(`\`${text}\``)
    .map((c) => ({ ...c, start: c.start - 1, end: c.end - 1 }))
    .filter((c) => c.start >= 0 && c.end <= text.length)
}

/** The candidate texts to ask main about, each once, in order. */
export function pathTexts(text: string, code = false): string[] {
  return [...new Set(candidatesIn(text, code).map((c) => c.text))]
}

/**
 * The text cut into plain pieces and links. Only a candidate main found on
 * disk becomes a link; everything else stays exactly as written.
 */
export function linkify(text: string, resolved: ReadonlyMap<string, ResolvedPath>, code = false): LinkPiece[] {
  if (text === '') return []
  if (resolved.size === 0) return [text]
  const out: LinkPiece[] = []
  let at = 0
  for (const c of candidatesIn(text, code)) {
    const target = resolved.get(c.text)
    if (!target || c.start < at) continue
    if (c.start > at) out.push(text.slice(at, c.start))
    out.push({ text: c.text, target })
    at = c.end
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}

function segments(path: string): string[] {
  return path.replace(/\//g, '\\').split('\\').filter((s) => s !== '')
}

/**
 * `absPath` as seen from the tab's folder, the way Windows writes it:
 * `src\a.ts`. Outside the folder it climbs with `..`; on another drive, or
 * with no folder, the full path is all there is.
 */
export function relativePath(cwd: string, absPath: string): string {
  const from = segments(cwd)
  const to = segments(absPath)
  const same = (a: string | undefined, b: string | undefined): boolean =>
    a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()
  if (from.length === 0 || !same(from[0], to[0])) return absPath
  let common = 0
  while (common < from.length && common < to.length && same(from[common], to[common])) common++
  const up = from.slice(common).map(() => '..')
  const parts = [...up, ...to.slice(common)]
  return parts.length === 0 ? '.' : parts.join('\\')
}
