import type { ContextInfo } from '../../shared/types'
import { contextSegments } from '../panel/contextSegments'

const tokens = (n: number): string => n.toLocaleString('ru-RU')

/**
 * What fills the context window: one bar and, under it, a legend that names
 * every part. The bar alone never says which part is which — the colour only
 * ties a bar part to its legend row.
 */
export function ContextBreakdown({ context }: { context: ContextInfo }): JSX.Element {
  // An estimate from the record has no rows: the whole of it is just «занято».
  const rows = context.categories.length > 0 ? context.categories : [{ name: 'Занято', tokens: context.used }]
  const segments = contextSegments(rows, context.max)
  const label = segments.map((s) => `${s.name}: ${tokens(s.tokens)}`).join('; ')

  return (
    <div className="context-breakdown">
      <div className="context-bar" data-testid="context-bar" role="img" aria-label={label}>
        {segments.map((s) => (
          <div
            key={s.name}
            className="context-seg"
            data-fill={s.fill}
            style={{ flexGrow: s.share }}
          />
        ))}
      </div>
      <table className="context-legend" data-testid="context-legend">
        <tbody>
          {segments.map((s) => (
            <tr key={s.name} data-testid="context-legend-row" data-fill={s.fill}>
              <td className="context-swatch-cell">
                <span className="context-swatch" data-fill={s.fill} aria-hidden="true" />
              </td>
              <th scope="row">{s.name}</th>
              <td className="context-tokens">{tokens(s.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
