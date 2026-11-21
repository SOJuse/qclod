import type { ResolvedPath } from '../../shared/types'
import type { PaneLayerState } from '../state/useAppStore'
import { splitPathLine } from './pathLine'

/**
 * Text types the viewer shows: the text and source part of main's OPENABLE
 * (src/main/files/fileActions.ts) — no pictures, no PDF, nothing a program runs.
 */
const VIEWABLE = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.log', '.diff', '.patch', '.ts', '.tsx', '.mts', '.cts', '.css', '.scss', '.less',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.rs', '.go', '.java', '.cs'
])

export function isViewableText(path: string): boolean {
  const name = path.replace(/[. ]+$/, '')
  const dot = name.lastIndexOf('.')
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf(String.fromCharCode(92)))
  return dot > slash && VIEWABLE.has(name.slice(dot).toLowerCase())
}

/** The layer «Посмотреть» opens for a path found in the chat, or null when it is not for the viewer. */
export function viewLayerFor(target: ResolvedPath): PaneLayerState | null {
  if (target.isDir || !isViewableText(target.absPath)) return null
  const line = target.line ?? splitPathLine(target.raw).line
  return { kind: 'file', path: target.absPath, ...(line !== undefined ? { line } : {}) }
}
