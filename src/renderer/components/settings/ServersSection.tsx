import { useState } from 'react'
import type { ServerColour, ServerView, TabState } from '../../../shared/types'
import { SERVER_COLOUR_LIST } from '../../../shared/serverColours'
import { useAppStore } from '../../state/useAppStore'
import { AddServerForm, type NewServer } from '../servers/AddServerForm'
import { canRememberPasswords } from '../servers/ServersSheet'
import type { SettingsSectionProps } from './types'
import '../servers/servers.css'

const COLOUR_NAME: Record<ServerColour, string> = {
  blue: 'синий',
  violet: 'фиолетовый',
  green: 'зелёный',
  amber: 'янтарный',
  rose: 'розовый',
  cyan: 'бирюзовый'
}

export const RELAY_RESTART_CONFIRM = 'Агенты на сервере перезапустятся с тем же разговором. Обновить?'

function entryOf(s: ServerView, patch: Partial<NewServer> = {}): NewServer {
  return {
    id: s.id,
    label: s.label,
    target: s.target,
    ...(s.port !== undefined ? { port: s.port } : {}),
    ...(s.identityFile ? { identityFile: s.identityFile } : {}),
    auth: s.auth,
    colour: s.colour,
    fromConfig: s.fromConfig,
    ...patch
  }
}

/** Agents of this server at work now: an update that restarts them asks first. */
function workingOn(tabs: TabState[], hostId: string): number {
  return tabs.filter((t) => t.server?.hostId === hostId && (t.status === 'busy' || t.status === 'waiting')).length
}

export function ServerCard({ server, working }: { server: ServerView; working: number }): JSX.Element {
  const [label, setLabel] = useState(server.label)
  const [confirming, setConfirming] = useState(false)
  const save = (patch: Partial<NewServer>): void => {
    void window.qclod.saveServer(entryOf(server, patch) as never).catch(() => undefined)
  }
  const update = (force: boolean): void => {
    setConfirming(false)
    void window.qclod.updateRelay(server.id, force).catch(() => undefined)
  }
  return (
    <section className="server-card" data-testid="server-card" data-colour={server.colour}>
      <div className="server-card-head">
        <span className="server-dot" aria-hidden="true" />
        <input
          className="field"
          aria-label="Метка"
          data-testid="server-card-label"
          maxLength={200}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            if (label.trim() !== '' && label !== server.label) save({ label: label.trim() })
          }}
        />
      </div>
      <div className="server-colours" role="radiogroup" aria-label="Цвет">
        {SERVER_COLOUR_LIST.map((colour) => (
          <button
            key={colour}
            type="button"
            role="radio"
            className="server-colour"
            data-colour={colour}
            aria-checked={server.colour === colour}
            aria-label={COLOUR_NAME[colour]}
            title={COLOUR_NAME[colour]}
            onClick={() => save({ colour })}
          />
        ))}
      </div>
      <p className="field-hint">{server.target}</p>
      {server.hasPassword && (
        <p className="server-account">
          <span>
            Пароль сохранён —{' '}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="server-forget"
              onClick={() => void window.qclod.forgetServerPassword(server.id)}
            >
              Забыть
            </button>
          </span>
        </p>
      )}
      {server.info?.relay && <p className="field-hint">Посредник {server.info.relay}</p>}
      {server.relayUpdate &&
        (confirming ? (
          <div className="server-actions">
            <span className="field-hint">{RELAY_RESTART_CONFIRM}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>
              Отмена
            </button>
            <button type="button" className="btn btn-primary btn-sm" data-testid="relay-update-confirm" onClick={() => update(true)}>
              Обновить
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            data-testid="relay-update"
            onClick={() => (server.relayUpdate === 'required' && working > 0 ? setConfirming(true) : update(server.relayUpdate === 'required'))}
          >
            Обновить посредник
          </button>
        ))}
      <div className="server-actions">
        <button
          type="button"
          className="btn btn-danger btn-sm"
          data-testid="server-remove"
          onClick={() => void window.qclod.removeServer(server.id)}
        >
          Удалить сервер
        </button>
      </div>
    </section>
  )
}

/** «Серверы» in settings: every server's label, colour, password and relay; the form to add one. */
export function ServersSection(_props: SettingsSectionProps): JSX.Element {
  const servers = useAppStore((s) => s.servers)
  const tabs = useAppStore((s) => s.tabs)
  return <ServersList servers={servers} tabs={tabs} />
}

export function ServersList({ servers, tabs }: { servers: ServerView[]; tabs: TabState[] }): JSX.Element {
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="settings-servers" data-testid="settings-servers">
      {servers.length === 0 && <p className="field-hint">Серверов пока нет.</p>}
      {servers.map((s) => (
        <ServerCard key={s.id} server={s} working={workingOn(tabs, s.id)} />
      ))}
      {adding ? (
        <AddServerForm
          canRemember={canRememberPasswords(servers)}
          error={error}
          onCancel={() => setAdding(false)}
          onSubmit={(entry, password, then) => {
            setError(null)
            window.qclod.saveServer(entry as never, password).then(
              (list) => {
                setAdding(false)
                const saved = list.find((x) => x.target === entry.target)
                if (then === 'test' && saved) void window.qclod.connectServer(saved.id)
              },
              (err: unknown) => setError(err instanceof Error ? err.message : String(err))
            )
          }}
        />
      ) : (
        <button type="button" className="btn btn-sm" data-testid="settings-server-add" onClick={() => setAdding(true)}>
          Добавить сервер
        </button>
      )}
    </div>
  )
}
