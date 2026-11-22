import type { DiffHunk } from '../../../shared/toolView'
import { lines as linesWord } from '../../../shared/format'
import type { Token } from '../../markdown/highlight'

/** A diff longer than this is cut, with a count of what is left: the window stays quick. */
const MAX_DIFF_LINES = 400

/**
 * A change line by line: old and new line numbers, the sign, the text.
 *
 * Added and removed lines are told apart by the sign and the gutter numbers as
 * well as by their tint, so the diff still reads without colour. A diff's own
 * note («\ No newline at end of file») is shown dimmed and takes no number.
 */
export function DiffView({ hunks }: { hunks: DiffHunk[] }): JSX.Element {
  let budget = MAX_DIFF_LINES
  let hidden = 0
  const shown = hunks.map((hunk, h) => {
    let oldNo = hunk.oldStart
    let newNo = hunk.newStart
    const rows: JSX.Element[] = []
    hunk.lines.forEach((line, i) => {
      const sign = line[0]
      if (sign === '\\') {
        if (budget > 0) rows.push(<div key={i} className="diff-note">{line.slice(1).trim()}</div>)
        return
      }
      if (budget <= 0) {
        hidden++
        return
      }
      budget--
      const text = line.slice(1)
      if (sign === '+') {
        rows.push(<DiffLine key={i} kind="add" oldNo="" newNo={String(newNo++)} sign="+" text={text} />)
      } else if (sign === '-') {
        rows.push(<DiffLine key={i} kind="del" oldNo={String(oldNo++)} newNo="" sign="−" text={text} />)
      } else {
        rows.push(<DiffLine key={i} kind="ctx" oldNo={String(oldNo++)} newNo={String(newNo++)} sign="" text={text} />)
      }
    })
    return rows.length > 0 ? (
      <div className="diff-hunk" key={h}>
        {rows}
      </div>
    ) : null
  })

  return (
    <div className="diff" data-testid="tool-diff">
      {shown}
      {hidden > 0 && <div className="diff-note">и ещё {linesWord(hidden)}</div>}
    </div>
  )
}

/** One row of a diff; `tokens` (syntax colour) replace the plain text when given. */
export function DiffLine({
  kind,
  oldNo,
  newNo,
  sign,
  text,
  tokens
}: {
  kind: 'add' | 'del' | 'ctx'
  oldNo: string
  newNo: string
  sign: string
  text: string
  tokens?: Token[]
}): JSX.Element {
  return (
    <div className={`diff-line is-${kind}`}>
      <span className="diff-no">{oldNo}</span>
      <span className="diff-no">{newNo}</span>
      <span className="diff-sign" aria-hidden="true">
        {sign}
      </span>
      <span className="diff-text">
        {tokens
          ? tokens.map((t, i) => (
              <span key={i} className={`tok-${t.kind}`}>
                {t.text}
              </span>
            ))
          : text}
      </span>
    </div>
  )
}
