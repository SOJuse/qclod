import { useMemo } from 'react'
import type { GitFileDiff } from '../../../shared/types'
import { bytes, lines as linesWord } from '../../../shared/format'
import { highlight } from '../../markdown/highlight'
import { DiffLine } from '../tool/DiffView'
import { languageOf } from './language'
import './DiffViewer.css'

/**
 * A file's change from git, read-only, with syntax colour line by line (a
 * multi-line comment may be coloured loosely — the cost of not parsing).
 * Fits any unified diff, not only git's own.
 */
export function DiffViewer({ diff, path }: { diff: GitFileDiff; path: string }): JSX.Element {
  const language = useMemo(() => languageOf(path), [path])
  return (
    <div className="diff-viewer" data-testid="diff-viewer">
      {body(diff, language)}
    </div>
  )
}

/** git's own note line (No newline at end of file) starts with a backslash. */
const BACKSLASH = String.fromCharCode(92)

function body(diff: GitFileDiff, language: string): JSX.Element {
  switch (diff.kind) {
    case 'binary':
      return <p className="diff-viewer-note">Двоичный файл — изменения не показываются.</p>
    case 'tooLarge':
      return <p className="diff-viewer-note">Изменения слишком большие для просмотра ({bytes(diff.bytes)}).</p>
    case 'error':
      return (
        <p className="diff-viewer-note" role="alert">
          {diff.message}
        </p>
      )
    case 'text':
      break
  }
  return (
    <div className="diff">
      {diff.hunks.map((hunk, h) => {
        let oldNo = hunk.oldStart
        let newNo = hunk.newStart
        return (
          <div className="diff-hunk" key={h}>
            {hunk.lines.map((line, i) => {
              const sign = line[0]
              if (sign === BACKSLASH) {
                return (
                  <div key={i} className="diff-note">
                    {line.slice(1).trim()}
                  </div>
                )
              }
              const text = line.slice(1)
              const tokens = highlight(text, language)[0] ?? []
              if (sign === '+') {
                return <DiffLine key={i} kind="add" oldNo="" newNo={String(newNo++)} sign="+" text={text} tokens={tokens} />
              }
              if (sign === '-') {
                return <DiffLine key={i} kind="del" oldNo={String(oldNo++)} newNo="" sign="−" text={text} tokens={tokens} />
              }
              return (
                <DiffLine key={i} kind="ctx" oldNo={String(oldNo++)} newNo={String(newNo++)} sign="" text={text} tokens={tokens} />
              )
            })}
          </div>
        )
      })}
      {diff.truncatedLines > 0 && <div className="diff-note">и ещё {linesWord(diff.truncatedLines)}</div>}
    </div>
  )
}
