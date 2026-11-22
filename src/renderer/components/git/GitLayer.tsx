import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommitResult, FileSource, GitChange, GitFileDiff, GitStatus } from '../../../shared/types'
import { plural } from '../../../shared/format'
import { DiffViewer } from '../viewer/DiffViewer'
import { FileViewer } from '../viewer/FileViewer'

import './GitLayer.css'

type Ok = Extract<GitStatus, { kind: 'ok' }>

const KIND_LABEL: Record<GitChange['kind'], string> = {
  modified: 'изменён',
  added: 'добавлен',
  deleted: 'удалён',
  renamed: 'переименован',
  untracked: 'новый',
  conflict: 'конфликт',
  typechange: 'тип изменён'
}

export function kindLabel(change: GitChange): string {
  const label = KIND_LABEL[change.kind]
  return change.kind === 'renamed' && change.oldPath !== undefined ? `${label} из ${change.oldPath}` : label
}

/** The layer's title (the pane layer's header), by what git said. */
export function gitTitle(status: GitStatus | null): string {
  if (status?.kind !== 'ok') return 'Изменения'
  if (status.initial) return 'Изменения · первый коммит'
  if (status.detachedAt) return `Изменения · отдельный коммит ${status.detachedAt}`
  return status.branch ? `Изменения · ${status.branch}` : 'Изменения'
}

export function commitLabel(count: number, busy: boolean): string {
  return busy ? 'Коммичу…' : `Закоммитить ${count} ${plural(count, 'файл', 'файла', 'файлов')}`
}

/** What is ticked: every change but the ones the person unticked, and never a conflict. */
export function tickedPaths(status: Ok, unticked: ReadonlySet<string>): string[] {
  return status.changes.filter((c) => c.kind !== 'conflict' && !unticked.has(c.path)).map((c) => c.path)
}

/** A draft message lives while the window is open, per chat. */
const drafts = new Map<string, string>()

function splitDir(path: string): [string, string] {
  const at = path.lastIndexOf('/')
  return at < 0 ? ['', path] : [path.slice(0, at + 1), path.slice(at + 1)]
}

function joinPath(cwd: string, path: string): string {
  return `${cwd.replace(/[\\/]+$/, '')}/${path}`
}

const DOWNLOAD = 'https://git-scm.com/downloads'

export interface GitLayerProps {
  tabId: string
  source: FileSource
  cwd: string
  status: GitStatus | null
  refresh: () => void
  refreshNow: () => void
}

/**
 * The folder's changes over the ribbon: files with ticks, one file's diff, and
 * a commit of the ticked ones with one message. No push, no branches, no undo —
 * that is the agent's or the terminal's.
 */
export function GitLayer({ tabId, source, cwd, status, refresh, refreshNow }: GitLayerProps): JSX.Element {
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [full, setFull] = useState<string | null>(null)
  const [message, setMessage] = useState(() => drafts.get(tabId) ?? '')
  const [committing, setCommitting] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<Extract<CommitResult, { ok: false }> | null>(null)
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const ok = status?.kind === 'ok' ? status : null
  const changes = ok?.changes ?? []
  const present = useMemo(() => new Set(changes.map((c) => c.path)), [changes])
  const hasConflict = changes.some((c) => c.kind === 'conflict')
  const ticked = ok ? tickedPaths(ok, unticked) : []
  const selectedChange = changes.find((c) => c.path === selected) ?? null

  // The chosen file left the list (committed by the agent, say): the choice goes with it.
  useEffect(() => {
    if (selected !== null && !present.has(selected)) {
      setSelected(null)
      setDiff(null)
      setFull(null)
    }
  }, [present, selected])

  useEffect(() => {
    if (selected === null || !ok) return
    let live = true
    window.qclod
      .gitDiff(tabId, selected)
      .then((d) => {
        if (live) setDiff(d)
      })
      .catch(() => {
        if (live) setDiff({ kind: 'error', message: 'Не удалось получить изменения.' })
      })
    return () => {
      live = false
    }
    // A new status (the files may have changed again) asks for the diff anew.
  }, [tabId, selected, status])

  useEffect(
    () => () => {
      if (doneTimer.current) clearTimeout(doneTimer.current)
    },
    []
  )

  const toggle = (path: string): void =>
    setUnticked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  const selectable = changes.filter((c) => c.kind !== 'conflict')
  const allTicked = selectable.length > 0 && selectable.every((c) => !unticked.has(c.path))
  const toggleAll = (): void => setUnticked(allTicked ? new Set(selectable.map((c) => c.path)) : new Set())

  const edit = (text: string): void => {
    setMessage(text)
    drafts.set(tabId, text)
  }

  const canCommit = ok !== null && message.trim() !== '' && ticked.length > 0 && !hasConflict && !committing

  const commit = (): void => {
    if (!canCommit) return
    setCommitting(true)
    setRefusal(null)
    setDone(null)
    window.qclod
      .gitCommit(tabId, ticked, message)
      .then((result) => {
        if (result.ok) {
          edit('')
          setUnticked(new Set())
          setDone(`Закоммичено: ${result.hash} ${result.summary}`)
          if (doneTimer.current) clearTimeout(doneTimer.current)
          doneTimer.current = setTimeout(() => setDone(null), 4_000)
        } else {
          setRefusal(result)
        }
        refreshNow()
      })
      .catch(() => setRefusal({ ok: false, reason: 'failed', message: 'Не удалось закоммитить.' }))
      .finally(() => setCommitting(false))
  }

  if (full !== null) {
    return (
      <div className="git-layer" data-testid="git-layer">
        <FileViewer
          tabId={tabId}
          source={source}
          path={joinPath(cwd, full)}
          onClose={() => setFull(null)}
          closeLabel="Назад к изменениям"
        />
      </div>
    )
  }

  if (status === null) {
    return (
      <div className="git-layer" data-testid="git-layer">
        <p className="git-note">Загружаю…</p>
      </div>
    )
  }
  if (status.kind === 'notRepo') {
    return (
      <div className="git-layer" data-testid="git-layer">
        <p className="git-note">Эта папка не под Git.</p>
      </div>
    )
  }
  if (status.kind === 'noGit') {
    return (
      <div className="git-layer" data-testid="git-layer">
        <p className="git-note">
          Git не найден. Поставьте Git:{' '}
          <a
            href={DOWNLOAD}
            onClick={(e) => {
              e.preventDefault()
              void window.qclod.openExternal(DOWNLOAD)
            }}
          >
            {DOWNLOAD}
          </a>
        </p>
      </div>
    )
  }
  if (status.kind === 'unavailable' || status.kind === 'error') {
    return (
      <div className="git-layer" data-testid="git-layer">
        <p className="git-note" role="alert">
          {status.kind === 'unavailable' ? status.reason : status.message}
        </p>
        <button type="button" className="git-button" data-testid="git-refresh" onClick={refreshNow}>
          Обновить
        </button>
      </div>
    )
  }

  return (
    <div className="git-layer" data-testid="git-layer">
      <div className="git-bar">
        <label className="git-all">
          <input type="checkbox" data-testid="git-all" checked={allTicked} disabled={selectable.length === 0} onChange={toggleAll} />
          <span>Все</span>
        </label>
        <span className="git-gap" />
        <button type="button" className="git-button" data-testid="git-refresh" onClick={refresh}>
          Обновить
        </button>
      </div>

      {changes.length === 0 ? (
        <p className="git-note">Изменений нет — рабочая папка чистая.</p>
      ) : (
        <div className="git-split">
          <div className="git-files" data-testid="git-files">
            {changes.map((change) => {
              const [dir, name] = splitDir(change.path)
              const conflict = change.kind === 'conflict'
              return (
                <div
                  key={change.path}
                  className={`git-file${selected === change.path ? ' is-selected' : ''}`}
                  data-testid="git-file"
                  data-path={change.path}
                  data-kind={change.kind}
                >
                  <input
                    type="checkbox"
                    data-testid="git-file-check"
                    aria-label={`Включить в коммит: ${change.path}`}
                    checked={!conflict && !unticked.has(change.path)}
                    disabled={conflict}
                    onChange={() => toggle(change.path)}
                  />
                  <button
                    type="button"
                    className="git-file-open"
                    title={change.path}
                    onClick={() => {
                      setSelected(change.path)
                      setDiff(null)
                    }}
                  >
                    <span className="git-file-name">
                      {dir && <span className="git-file-dir">{dir}</span>}
                      {name}
                    </span>
                    <span className="git-file-kind">{kindLabel(change)}</span>
                  </button>
                </div>
              )
            })}
            {ok?.truncated && <p className="git-note">Показаны первые 2000 изменений.</p>}
          </div>

          <div className="git-diff">
            {selectedChange === null ? (
              <p className="git-note">Выберите файл, чтобы увидеть изменения.</p>
            ) : (
              <>
                <div className="git-diff-head">
                  <span className="git-diff-path" title={selectedChange.path}>
                    {selectedChange.path}
                  </span>
                  {selectedChange.kind !== 'deleted' && (
                    <button type="button" className="git-button" data-testid="git-full-file" onClick={() => setFull(selectedChange.path)}>
                      Весь файл
                    </button>
                  )}
                </div>
                {diff === null ? <p className="git-note">Загружаю…</p> : <DiffViewer diff={diff} path={selectedChange.path} />}
              </>
            )}
          </div>
        </div>
      )}

      <div className="git-commit">
        {done && (
          <p className="git-done" role="status" data-testid="git-done">
            {done}
          </p>
        )}
        {refusal && (
          <div className="git-refusal" role="alert" data-testid="git-refusal">
            {refusal.reason === 'failed' ? (
              <>
                <p>Git не дал закоммитить:</p>
                <pre className="git-refusal-output">{refusal.message}</pre>
              </>
            ) : (
              <p>{refusal.message}</p>
            )}
          </div>
        )}
        {hasConflict && <p className="git-note">{'Есть конфликты слияния: коммит отключён.'}</p>}
        <textarea
          className="git-message"
          data-testid="git-message"
          placeholder="Что сделано — сообщение коммита"
          value={message}
          rows={2}
          onChange={(e) => edit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              commit()
            }
          }}
        />
        <button type="button" className="git-button is-primary" data-testid="git-commit" disabled={!canCommit} onClick={commit}>
          {commitLabel(ticked.length, committing)}
        </button>
      </div>
    </div>
  )
}
