import type { GitChange, GitChangeKind, GitStatus } from '../../shared/types'

export const STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '-z',
  '--branch',
  '--untracked-files=all',
  '--find-renames'
]

/** More changes than this are cut: the list stays usable and the commit stays checkable. */
export const MAX_CHANGES = 2_000

type Ok = Omit<Extract<GitStatus, { kind: 'ok' }>, 'kind'>

function kindOf(xy: string): GitChangeKind {
  const x = xy[0] ?? '.'
  const y = xy[1] ?? '.'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A' || y === 'A' || x === 'C' || y === 'C') return 'added'
  if (x === 'T' || y === 'T') return 'typechange'
  return 'modified'
}

/** Skips `n` space-separated fields; the rest of the record is the path, spaces and all. */
function pathAfter(record: string, n: number): string {
  let at = 0
  for (let i = 0; i < n; i++) {
    const next = record.indexOf(' ', at)
    if (next < 0) return ''
    at = next + 1
  }
  return record.slice(at)
}

/** `git status --porcelain=v2 -z --branch` → what the panel shows. Paths are taken verbatim. */
export function parseStatusV2(out: string): Ok {
  const parts = out.split('\0')
  let branch: string | null = null
  let oid = ''
  let detached = false
  let initial = false
  const changes: GitChange[] = []
  let truncated = false

  const add = (change: GitChange): void => {
    if (changes.length >= MAX_CHANGES) truncated = true
    else changes.push(change)
  }

  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i] ?? ''
    if (rec === '') continue
    if (rec.startsWith('# ')) {
      if (rec.startsWith('# branch.head ')) {
        const head = rec.slice('# branch.head '.length)
        if (head === '(detached)') detached = true
        else branch = head
      } else if (rec.startsWith('# branch.oid ')) {
        oid = rec.slice('# branch.oid '.length)
        if (oid === '(initial)') initial = true
      }
      continue
    }
    const tag = rec[0]
    if (tag === '1') {
      add({ path: pathAfter(rec, 8), kind: kindOf(rec.slice(2, 4)) })
    } else if (tag === '2') {
      const path = pathAfter(rec, 9)
      const oldPath = parts[++i] ?? ''
      add({ path, oldPath, kind: 'renamed' })
    } else if (tag === 'u') {
      add({ path: pathAfter(rec, 10), kind: 'conflict' })
    } else if (tag === '?') {
      add({ path: rec.slice(2), kind: 'untracked' })
    }
    // '!' (ignored) and anything unknown: skipped.
  }

  return {
    branch: detached ? null : branch,
    detachedAt: detached && !initial ? oid.slice(0, 7) : null,
    initial,
    changes,
    truncated
  }
}
