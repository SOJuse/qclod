import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ConnectStep, ServerView, TabState } from '../../../shared/types'
import { AddServerForm, type NewServer } from './AddServerForm'
import { ConnectChecklist } from './ConnectChecklist'
import { RemoteFolderPicker } from './RemoteFolderPicker'
import { ServerPicker } from './ServerPicker'
import './servers.css'

export type ServersSheetMode =
  | { kind: 'picker' }
  | { kind: 'add' }
  | { kind: 'connect'; hostId: string; path?: string }
  | { kind: 'folder'; hostId: string }

interface Props {
  servers: ServerView[]
  steps: Record<string, ConnectStep[]>
  initial?: ServersSheetMode
  onClose: () => void
  onOpened: (tab: TabState) => void
}

function reasonOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Whether «Запомнить» can be offered: not when a server already said the OS store is out. */
export function canRememberPasswords(servers: ServerView[]): boolean {
  return !servers.some((s) => s.canStorePassword === false)
}

/**
 * A new chat on a server, in one sheet: pick (or add) a server, the
 * connection checklist when it is not on line yet, the folder there — and
 * the chat (I6, «сразу чат»).
 */
export function ServersSheet({ servers, steps, initial = { kind: 'picker' }, onClose, onOpened }: Props): JSX.Element {
  const [mode, setMode] = useState<ServersSheetMode>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    []
  )

  const opened = (tab: TabState): void => {
    onOpened(tab)
    onClose()
  }

  const openPath = (hostId: string, path: string): void => {
    void window.qclod.openServerFolder(hostId, path).then((tab) => {
      if (tab) opened(tab)
      else if (alive.current) setMode({ kind: 'folder', hostId })
    })
  }

  const connect = (hostId: string, path?: string): void => {
    setMode({ kind: 'connect', hostId, ...(path ? { path } : {}) })
    setBusy(true)
    window.qclod.connectServer(hostId).then(
      (ok) => {
        if (!alive.current) return
        setBusy(false)
        if (!ok) return
        if (path) openPath(hostId, path)
        else setMode({ kind: 'folder', hostId })
      },
      () => {
        if (alive.current) setBusy(false)
      }
    )
  }

  const pick = (server: ServerView): void => {
    if (server.state === 'online') setMode({ kind: 'folder', hostId: server.id })
    else connect(server.id)
  }

  const pickRecent = (server: ServerView, path: string): void => {
    if (server.state === 'online') openPath(server.id, path)
    else connect(server.id, path)
  }

  const save = (entry: NewServer, password: string | undefined, then: 'test' | 'save'): void => {
    setBusy(true)
    setError(null)
    window.qclod.saveServer(entry as never, password).then(
      (list) => {
        if (!alive.current) return
        setBusy(false)
        const saved = list.find((s) => s.target === entry.target && (entry.id === undefined || s.id === entry.id))
        if (then === 'test' && saved) connect(saved.id)
        else setMode({ kind: 'picker' })
      },
      (err: unknown) => {
        if (!alive.current) return
        setBusy(false)
        setError(reasonOf(err))
      }
    )
  }

  const server = mode.kind === 'connect' || mode.kind === 'folder' ? servers.find((s) => s.id === mode.hostId) : undefined
  const title =
    mode.kind === 'add' ? 'Добавить сервер' : mode.kind === 'connect' ? `Подключение: ${server?.label ?? ''}` : 'Новый чат на сервере'

  return (
    <div className="sheet-backdrop" data-testid="servers-sheet">
      <div className="sheet server-sheet" role="dialog" aria-modal="true" aria-labelledby="servers-sheet-title">
        <div className="sheet-head">
          <h2 className="sheet-title" id="servers-sheet-title">
            {title}
          </h2>
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Закрыть" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="sheet-body">
          {mode.kind === 'picker' && (
            <ServerPicker servers={servers} onPick={pick} onPickRecent={pickRecent} onAdd={() => setMode({ kind: 'add' })} />
          )}
          {mode.kind === 'add' && (
            <AddServerForm
              canRemember={canRememberPasswords(servers)}
              busy={busy}
              error={error}
              onSubmit={save}
              onCancel={() => setMode({ kind: 'picker' })}
            />
          )}
          {mode.kind === 'connect' && (
            <ConnectChecklist
              steps={steps[mode.hostId]}
              problem={server && server.state !== 'online' && server.state !== 'connecting' ? server.problem : undefined}
              busy={busy}
              onRetry={() => connect(mode.hostId, mode.path)}
            />
          )}
          {mode.kind === 'folder' && server && (
            <RemoteFolderPicker server={server} onOpened={opened} onCancel={() => setMode({ kind: 'picker' })} />
          )}
        </div>
      </div>
    </div>
  )
}
