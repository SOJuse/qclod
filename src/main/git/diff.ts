import type { GitFileDiff } from '../../shared/types'
import type { DiffHunk } from '../../shared/toolView'

/** A longer diff is cut, with a count of what is left: the window stays quick. */
export const MAX_DIFF_LINES = 5_000

/** git's empty tree: the base to diff against in a repository with no commit yet. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** One file's unified diff (`git diff` for a single path) → hunks in the `DiffView` shape. */
export function parseUnifiedDiff(text: string): GitFileDiff {
  const rows = text.split('\n')
  if (rows[rows.length - 1] === '') rows.pop()

  const hunks: DiffHunk[] = []
  let current: DiffHunk | null = null
  let added = 0
  let removed = 0
  let shown = 0
  let cut = 0

  for (const row of rows) {
    if (current === null && (/^Binary files .* differ$/.test(row) || row === 'GIT binary patch')) {
      return { kind: 'binary' }
    }
    const m = HUNK.exec(row)
    if (m) {
      current = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] }
      hunks.push(current)
      continue
    }
    if (current === null) continue // the header: diff --git, index, ---, +++
    const sign = row[0]
    if (sign === '\\') {
      if (shown < MAX_DIFF_LINES) current.lines.push(row)
      continue
    }
    if (sign === '+') added++
    else if (sign === '-') removed++
    else if (sign !== ' ' && row !== '') continue // not a hunk line
    if (shown >= MAX_DIFF_LINES) {
      cut++
      continue
    }
    shown++
    current.lines.push(row === '' ? ' ' : row)
  }

  return { kind: 'text', hunks, added, removed, truncatedLines: cut }
}
