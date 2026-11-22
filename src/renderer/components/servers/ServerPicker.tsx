import { Folder, Plus, Server } from 'lucide-react'
import type { ServerView } from '../../../shared/types'

interface Props {
  servers: ServerView[]
  onPick: (server: ServerView) => void
  onPickRecent: (server: ServerView, path: string) => void
  onAdd: () => void
}

/** How many recent server folders the list shows. */
const RECENT_SHOWN = 8

/** Where a new server chat starts: a recent folder, a server, a Host of ~/.ssh/config, or a new one. */
export function ServerPicker({ servers, onPick, onPickRecent, onAdd }: Props): JSX.Element {
  const recent = servers.flatMap((s) => s.recent.map((path) => ({ server: s, path }))).slice(0, RECENT_SHOWN)
  const mine = servers.filter((s) => !s.fromConfig)
  const fromConfig = servers.filter((s) => s.fromConfig)
  const row = (s: ServerView): JSX.Element => (
    <li key={s.id}>
      <button type="button" className="server-row" data-testid="server-row" data-state={s.state} onClick={() => onPick(s)}>
        <Server size={14} aria-hidden="true" />
        <span className="server-dot" data-colour={s.colour} aria-hidden="true" />
        <span className="server-row-label">{s.label}</span>
        {s.label !== s.target && <span className="server-row-hint">{s.target}</span>}
      </button>
    </li>
  )
  return (
    <div className="server-picker" data-testid="server-picker">
      {recent.length > 0 && (
        <section className="server-group">
          <h3>Недавние</h3>
          <ul>
            {recent.map(({ server, path }) => (
              <li key={`${server.id}:${path}`}>
                <button
                  type="button"
                  className="server-row"
                  data-testid="server-recent"
                  onClick={() => onPickRecent(server, path)}
                >
                  <Folder size={14} aria-hidden="true" />
                  <span className="server-dot" data-colour={server.colour} aria-hidden="true" />
                  <span className="server-row-label">{server.label}</span>
                  <span className="server-row-hint">{path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {mine.length > 0 && (
        <section className="server-group">
          <h3>Серверы</h3>
          <ul>{mine.map(row)}</ul>
        </section>
      )}
      {fromConfig.length > 0 && (
        <section className="server-group">
          <h3>Из ~/.ssh/config</h3>
          <ul>{fromConfig.map(row)}</ul>
        </section>
      )}
      <button type="button" className="btn btn-sm server-add" data-testid="server-add" onClick={onAdd}>
        <Plus size={14} aria-hidden="true" />
        Добавить сервер
      </button>
    </div>
  )
}
