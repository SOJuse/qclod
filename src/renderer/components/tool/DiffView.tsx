import type { DiffHunk } from '../../../shared/toolView'

/**
 * A change line by line: old and new line numbers, the sign, the text.
 *
 * Added and removed lines are told apart by the sign and the gutter numbers as
 * well as by their tint, so the diff still reads without colour.
 */
export function DiffView({ hunks }: { hunks: DiffHunk[] }): JSX.Element {
  return (
    <div className="diff" data-testid="tool-diff">
      {hunks.map((hunk, h) => {
        let oldNo = hunk.oldStart
        let newNo = hunk.newStart
        return (
          <div className="diff-hunk" key={h}>
            {hunk.lines.map((line, i) => {
              const sign = line[0]
              const text = line.slice(1)
              if (sign === '+') {
                return <DiffLine key={i} kind="add" oldNo="" newNo={String(newNo++)} sign="+" text={text} />
              }
              if (sign === '-') {
                return <DiffLine key={i} kind="del" oldNo={String(oldNo++)} newNo="" sign="−" text={text} />
              }
              return (
                <DiffLine key={i} kind="ctx" oldNo={String(oldNo++)} newNo={String(newNo++)} sign="" text={text} />
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function DiffLine({
  kind,
  oldNo,
  newNo,
  sign,
  text
}: {
  kind: 'add' | 'del' | 'ctx'
  oldNo: string
  newNo: string
  sign: string
  text: string
}): JSX.Element {
  return (
    <div className={`diff-line is-${kind}`}>
      <span className="diff-no">{oldNo}</span>
      <span className="diff-no">{newNo}</span>
      <span className="diff-sign" aria-hidden="true">
        {sign}
      </span>
      <span className="diff-text">{text}</span>
    </div>
  )
}
