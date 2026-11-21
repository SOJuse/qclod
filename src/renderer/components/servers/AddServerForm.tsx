import { useState } from 'react'
import type { ServerEntry, ServerView } from '../../../shared/types'

export type NewServer = Omit<ServerEntry, 'id' | 'colour' | 'recent'> & Partial<Pick<ServerEntry, 'id' | 'colour'>>

interface Props {
  /** A server to change; none — a new one. */
  initial?: ServerView | undefined
  /** safeStorage works: a password can be kept. */
  canRemember: boolean
  busy?: boolean
  error?: string | null | undefined
  /** `password` only when «Запомнить» is on (it is stored sealed, never in the clear). */
  onSubmit: (entry: NewServer, password: string | undefined, then: 'test' | 'save') => void
  onCancel?: () => void
}

/** A server by hand: a name, user@host or a Host of ~/.ssh/config, port, key or password. */
export function AddServerForm({ initial, canRemember, busy = false, error, onSubmit, onCancel }: Props): JSX.Element {
  const [label, setLabel] = useState(initial?.label ?? '')
  const [target, setTarget] = useState(initial?.target ?? '')
  const [port, setPort] = useState(initial?.port ? String(initial.port) : '')
  const [identityFile, setIdentityFile] = useState(initial?.identityFile ?? '')
  const [auth, setAuth] = useState<'key' | 'password'>(initial?.auth ?? 'key')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(canRemember)

  const entry = (): NewServer => ({
    ...(initial ? { id: initial.id, colour: initial.colour } : {}),
    label: label.trim(),
    target: target.trim(),
    ...(port.trim() !== '' ? { port: Number(port) } : {}),
    ...(auth === 'key' && identityFile.trim() !== '' ? { identityFile: identityFile.trim() } : {}),
    auth,
    fromConfig: initial?.fromConfig ?? false
  })
  const submit = (then: 'test' | 'save'): void => {
    const keep = auth === 'password' && canRemember && remember && password !== '' ? password : undefined
    onSubmit(entry(), keep, then)
  }
  const canSave = target.trim() !== '' && !busy

  return (
    <form
      className="server-form"
      data-testid="add-server-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) submit('save')
      }}
    >
      <label className="settings-field">
        <span className="field-label">Имя (необязательно)</span>
        <input className="field" data-testid="server-label" maxLength={200} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="settings-field">
        <span className="field-label">Хост — user@host или имя из ~/.ssh/config</span>
        <input
          className="field"
          data-testid="server-target"
          maxLength={255}
          spellCheck={false}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
      </label>
      <label className="settings-field">
        <span className="field-label">Порт</span>
        <input
          className="field server-port"
          data-testid="server-port"
          inputMode="numeric"
          placeholder="22"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
        />
      </label>
      <div className="server-auth" role="radiogroup" aria-label="Ключ / Пароль">
        <button
          type="button"
          role="radio"
          aria-checked={auth === 'key'}
          className={`btn btn-sm${auth === 'key' ? ' is-on' : ''}`}
          data-testid="server-auth-key"
          onClick={() => setAuth('key')}
        >
          Ключ
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={auth === 'password'}
          className={`btn btn-sm${auth === 'password' ? ' is-on' : ''}`}
          data-testid="server-auth-password"
          onClick={() => setAuth('password')}
        >
          Пароль
        </button>
      </div>
      {auth === 'key' ? (
        <label className="settings-field">
          <span className="field-label">Ключ (необязательно, иначе ssh-agent)</span>
          <input
            className="field"
            data-testid="server-key"
            maxLength={4096}
            spellCheck={false}
            value={identityFile}
            onChange={(e) => setIdentityFile(e.target.value)}
          />
        </label>
      ) : (
        <>
          <label className="settings-field">
            <span className="field-label">Пароль</span>
            <input
              className="field"
              type="password"
              data-testid="server-password"
              maxLength={4096}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              data-testid="server-remember"
              checked={canRemember && remember}
              disabled={!canRemember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>Запомнить в системном хранилище</span>
          </label>
          {!canRemember && <p className="field-hint">Системное хранилище недоступно</p>}
        </>
      )}
      {error && (
        <p className="server-error" role="alert">
          {error}
        </p>
      )}
      <div className="server-actions">
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Отмена
          </button>
        )}
        <button type="button" className="btn btn-sm" data-testid="server-test" disabled={!canSave} onClick={() => submit('test')}>
          Проверить соединение
        </button>
        <button type="submit" className="btn btn-primary btn-sm" data-testid="server-save" disabled={!canSave}>
          Сохранить
        </button>
      </div>
    </form>
  )
}
