import { useEffect, useRef, useState } from 'react'
import type { ServerView } from '../../../shared/types'
import { focusInto, useModalSheet } from '../../ui/modalFocus'
import { reasonOf } from '../../ui/StateView'

export interface LoginProgress {
  url?: string
  state: 'starting' | 'waitingCode' | 'checking' | 'done' | 'failed'
  email?: string
  error?: string
}

/** The server's Claude account, in the chat's panel: who, which plan, or «Войти». */
export function ServerAccount({ server, onLogin }: { server: ServerView; onLogin: () => void }): JSX.Element {
  const account = server.account
  return (
    <div className="server-account" data-testid="server-account">
      <span>Сервер: {server.label}</span>
      {account?.loggedIn === true ? (
        <span>Аккаунт: {[account.email, account.plan].filter(Boolean).join(' · ')}</span>
      ) : account?.loggedIn === false ? (
        <span>
          Вход не выполнен{' '}
          <button type="button" className="btn btn-sm" data-testid="server-login" onClick={onLogin}>
            Войти
          </button>
        </span>
      ) : (
        <span>Аккаунт: не удалось узнать</span>
      )}
    </div>
  )
}

/** Only an https link is opened (the text came from the server). */
export function safeLoginUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export function ServerLoginView({
  server,
  progress,
  onOpenLink,
  onCode,
  onRetry,
  onClose
}: {
  server: ServerView
  progress: LoginProgress | null
  onOpenLink: (url: string) => void
  onCode: (code: string) => void
  onRetry: () => void
  onClose: () => void
}): JSX.Element {
  const [code, setCode] = useState('')
  const url = safeLoginUrl(progress?.url)
  const sheet = useRef<HTMLDivElement>(null)
  const onKeyDown = useModalSheet(sheet, onClose)
  const step = progress?.state === 'done' || progress?.state === 'failed' ? progress.state : 'code'
  // Modal (R2): focus in the code field, or on the sheet's first button once it is done or failed.
  useEffect(() => focusInto(sheet.current), [step])
  return (
    <div className="sheet-backdrop" data-testid="server-login-dialog">
      <div
        ref={sheet}
        className="sheet server-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-login-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="sheet-head">
          <h2 className="sheet-title" id="server-login-title">
            Вход в Claude на сервере {server.label}
          </h2>
        </div>
        <div className="sheet-body">
          {progress?.state === 'done' ? (
            <p data-testid="server-login-done">Вход выполнен: {progress.email ?? ''}</p>
          ) : progress?.state === 'failed' ? (
            <p className="server-error" role="alert">
              Войти не получилось: {progress.error ?? ''}
            </p>
          ) : (
            <>
              <p>1. Откройте ссылку и войдите в аккаунт, которым пользуется сервер</p>
              <button
                type="button"
                className="btn btn-sm"
                data-testid="server-login-open"
                disabled={!url}
                onClick={() => url && onOpenLink(url)}
              >
                Открыть ссылку
              </button>
              <p>2. Вставьте код из браузера</p>
              <form
                className="remote-path"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (code.trim() !== '') onCode(code.trim())
                }}
              >
                <input
                  className="field"
                  data-testid="server-login-code"
                  data-autofocus=""
                  maxLength={4096}
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={code.trim() === '' || progress?.state === 'checking'}
                >
                  Готово
                </button>
              </form>
            </>
          )}
        </div>
        <div className="sheet-foot">
          {progress?.state === 'failed' && (
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Ещё раз
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  )
}

/** `claude auth login` on the server, driven from here: a link to open and a code to paste back. */
export function ServerLoginDialog({ server, onClose }: { server: ServerView; onClose: () => void }): JSX.Element {
  const [progress, setProgress] = useState<LoginProgress | null>(null)
  const start = (): void => {
    setProgress({ state: 'starting' })
    window.qclod.serverLogin(server.id).catch((err: unknown) => setProgress({ state: 'failed', error: reasonOf(err) }))
  }
  useEffect(() => {
    const off = window.qclod.onServerLoginProgress((e) => {
      if (e.hostId !== server.id) return
      const { hostId: _h, ...rest } = e
      setProgress(rest)
    })
    start()
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id])
  return (
    <ServerLoginView
      server={server}
      progress={progress}
      onOpenLink={(url) => void window.qclod.openExternal(url)}
      onCode={(code) =>
        void window.qclod
          .serverLoginCode(server.id, code)
          .catch((err: unknown) => setProgress({ state: 'failed', error: reasonOf(err) }))
      }
      onRetry={start}
      onClose={onClose}
    />
  )
}
