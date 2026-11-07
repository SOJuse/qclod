import type { RibbonItem } from '../../shared/types'

type Permission = Extract<RibbonItem, { kind: 'permission' }>

interface Props {
  item: Permission
  onAnswer: (requestId: string, behavior: 'allow' | 'deny', remember?: boolean) => void
}

/**
 * The agent wants to use a tool and is waiting.
 *
 * It sits in the ribbon where the tool's own card will go, rather than in a
 * modal over everything: the question belongs in the story at the point it was
 * asked, and v1's guessing at a menu the CLI drew is gone for good (spec 6.4).
 */
export function PermissionCard({ item, onAnswer }: Props): JSX.Element {
  return (
    <div className={`row-permission is-${item.state}`} data-testid="permission-card">
      <div className="row-permission-head">
        <strong>{item.toolName}</strong>
        <span className="row-permission-target">{item.target}</span>
      </div>
      {item.state === 'pending' ? (
        <div className="row-permission-actions">
          <button
            type="button"
            data-testid="permission-allow"
            onClick={() => onAnswer(item.requestId, 'allow')}
          >
            Разрешить
          </button>
          <button
            type="button"
            data-testid="permission-allow-all"
            onClick={() => onAnswer(item.requestId, 'allow', true)}
          >
            Разрешить всё такое
          </button>
          <button
            type="button"
            data-testid="permission-deny"
            onClick={() => onAnswer(item.requestId, 'deny')}
          >
            Отклонить
          </button>
        </div>
      ) : (
        <div className="row-permission-done">
          {item.state === 'allowed' ? 'разрешено' : 'отклонено'}
        </div>
      )}
    </div>
  )
}
