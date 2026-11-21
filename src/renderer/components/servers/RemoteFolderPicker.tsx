import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, FolderSymlink } from 'lucide-react'
import type { FsEntry } from '../../../shared/relayProtocol'
import type { ServerView, TabState } from '../../../shared/types'
import { reasonOf } from '../../ui/StateView'

export interface DirListing {
  path: string
  entries: FsEntry[]
  truncated: boolean
}

interface Props {
  server: ServerView
  onOpened: (tab: TabState) => void
  onCancel: () => void
}

/** The folder one level up; `~` and `/` stay where they are. */
export function parentPath(path: string): string {
  if (path === '/' || path === '~' || path === '') return path || '~'
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  if (at < 0) return '~'
  if (at === 0) return '/'
  return trimmed.slice(0, at)
}

/** The crumbs of a path: each a name and the path up to it. */
export function crumbs(path: string): Array<{ name: string; path: string }> {
  if (path === '') return []
  const home = path === '~' || path.startsWith('~/')
  const parts = path.replace(/^~\/?/, '').split('/').filter(Boolean)
  const out: Array<{ name: string; path: string }> = [home ? { name: '~', path: '~' } : { name: '/', path: '/' }]
  let acc = home ? '~' : ''
  for (const part of parts) {
    acc = `${acc}/${part}`
    out.push({ name: part, path: acc })
  }
  return out
}

/** The folder's own listing as the picker shows it: folders only, recent ones above. */
export function RemoteFolderView({
  server,
  listing,
  error,
  loading,
  typed,
  onType,
  onGo,
  onOpenHere,
  onCancel
}: {
  server: ServerView
  listing: DirListing | null
  error: string | null
  loading: boolean
  typed: string
  onType: (text: string) => void
  onGo: (path: string) => void
  onOpenHere: () => void
  onCancel: () => void
}): JSX.Element {
  const folders = (listing?.entries ?? []).filter((e) => e.kind === 'dir' || e.kind === 'link')
  const here = listing?.path ?? typed
  // «Открыть здесь» opens what is shown, and only once the field says the same:
  // after a failed step, or with a path typed but not gone to, it waits.
  const canOpen = listing !== null && !loading && error === null && listing.path === typed.trim()
  return (
    <div className="remote-picker" data-testid="remote-folder-picker">
      <h3 className="remote-picker-title">Папка на сервере {server.label}</h3>
      {server.recent.length > 0 && (
        <section className="server-group" data-testid="remote-recent">
          <h3>Недавние</h3>
          <ul>
            {server.recent.map((path) => (
              <li key={path}>
                <button type="button" className="server-row" onClick={() => onGo(path)}>
                  <Folder size={14} aria-hidden="true" />
                  <span className="server-row-label">{path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <form
        className="remote-path"
        onSubmit={(e) => {
          e.preventDefault()
          if (typed.trim() !== '') onGo(typed.trim())
        }}
      >
        <input
          className="field"
          data-testid="remote-path"
          data-autofocus=""
          placeholder="Путь, например ~/projects/app"
          spellCheck={false}
          maxLength={4096}
          value={typed}
          onChange={(e) => onType(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-testid="remote-up"
          aria-label="Вверх"
          title="Вверх"
          onClick={() => onGo(parentPath(here))}
        >
          <ArrowUp size={14} aria-hidden="true" />
          Вверх
        </button>
      </form>
      <nav className="remote-crumbs" aria-label="Путь">
        {crumbs(here).map((c) => (
          <button key={c.path} type="button" className="remote-crumb" onClick={() => onGo(c.path)}>
            {c.name}
          </button>
        ))}
      </nav>
      {error ? (
        <p className="server-error" role="alert" data-testid="remote-error">
          Не удалось открыть: {error}
        </p>
      ) : loading && !listing ? (
        <p className="field-hint">Загружаю…</p>
      ) : (
        <>
          {listing && folders.length === 0 && <p className="field-hint">Папка пуста</p>}
          <ul className="remote-list" data-testid="remote-list">
            {folders.map((entry) => {
              const path = here === '/' ? `/${entry.name}` : `${here}/${entry.name}`
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="server-row"
                    data-testid="remote-dir"
                    data-kind={entry.kind}
                    title={entry.kind === 'link' ? 'Ссылка. Двойной щелчок — войти' : 'Двойной щелчок — войти'}
                    onDoubleClick={() => onGo(path)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onGo(path)
                    }}
                  >
                    {entry.kind === 'link' ? (
                      <FolderSymlink size={14} aria-label="ссылка" />
                    ) : (
                      <Folder size={14} aria-hidden="true" />
                    )}
                    <span className="server-row-label">{entry.name}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          {listing?.truncated && <p className="field-hint">Показаны первые 2000</p>}
        </>
      )}
      <div className="server-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Отмена
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="remote-open-here"
          disabled={!canOpen}
          onClick={onOpenHere}
        >
          Открыть здесь
        </button>
      </div>
    </div>
  )
}

/** A folder on the server: browse, type a path, or take a recent one — «Открыть здесь» lands in a chat (I6). */
export function RemoteFolderPicker({ server, onOpened, onCancel }: Props): JSX.Element {
  const start = server.recent[0] ?? '~'
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [typed, setTyped] = useState(start)
  /** Only the last step's answer counts: an earlier one landing late is dropped. */
  const asked = useRef(0)

  const go = useCallback(
    (path: string): void => {
      const n = ++asked.current
      setLoading(true)
      setError(null)
      setTyped(path)
      window.qclod.listServerDir(server.id, path).then(
        (result) => {
          if (n !== asked.current) return
          setListing(result)
          setTyped(result.path)
          setLoading(false)
        },
        (err: unknown) => {
          if (n !== asked.current) return
          setError(reasonOf(err))
          setLoading(false)
        }
      )
    },
    [server.id]
  )
  useEffect(() => go(start), [go, start])

  const [opening, setOpening] = useState(false)
  const openHere = (): void => {
    if (!listing || opening) return
    setOpening(true)
    window.qclod.openServerFolder(server.id, listing.path).then(
      (tab) => {
        setOpening(false)
        if (tab) onOpened(tab)
        else setError('чат не открылся')
      },
      (err: unknown) => {
        setOpening(false)
        setError(`чат не открылся: ${reasonOf(err)}`)
      }
    )
  }

  return (
    <RemoteFolderView
      server={server}
      listing={listing}
      error={error}
      loading={loading || opening}
      typed={typed}
      onType={setTyped}
      onGo={go}
      onOpenHere={openHere}
      onCancel={onCancel}
    />
  )
}
