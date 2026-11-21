import { useState } from 'react'
import type { SshPrompt, SshPromptAnswer } from '../../../shared/types'

interface Props {
  prompt: SshPrompt
  onAnswer: (answer: SshPromptAnswer) => void
}

/**
 * A question ssh asked, put to the person. Its text came from the server
 * (keyboard-interactive): it is shown as plain text, never as markup.
 */
export function SshPromptDialog({ prompt, onAnswer }: Props): JSX.Element {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(prompt.kind === 'password' && prompt.canRemember)
  const cancel = (): void => onAnswer({ promptId: prompt.promptId, ok: false })

  if (prompt.kind === 'hostKey') {
    const type = prompt.keyType.toLowerCase()
    return (
      <div className="sheet-backdrop" data-testid="ssh-prompt">
        <div className="sheet server-sheet" role="dialog" aria-modal="true" aria-labelledby="ssh-prompt-title">
          <div className="sheet-head">
            <h2 className="sheet-title" id="ssh-prompt-title">
              Новый сервер: проверьте ключ
            </h2>
          </div>
          <div className="sheet-body">
            <p>
              Qclod впервые подключается к {prompt.host}. Отпечаток ключа ({prompt.keyType}):
            </p>
            <code className="server-fingerprint" data-testid="ssh-fingerprint">
              {prompt.fingerprint}
            </code>
            <p className="field-hint">Сверьте его на самом сервере: ssh-keygen -lf /etc/ssh/ssh_host_{type}_key.pub</p>
          </div>
          <div className="sheet-foot">
            <button type="button" className="btn btn-ghost" onClick={cancel}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="ssh-trust"
              onClick={() => onAnswer({ promptId: prompt.promptId, ok: true, value: 'yes' })}
            >
              Доверять
            </button>
          </div>
        </div>
      </div>
    )
  }

  const title =
    prompt.kind === 'password'
      ? `Пароль для ${prompt.text}`
      : prompt.kind === 'passphrase'
        ? `Пароль от ключа ${prompt.text}`
        : null
  const submit = (): void =>
    onAnswer({
      promptId: prompt.promptId,
      ok: true,
      value,
      ...(prompt.kind === 'password' && prompt.canRemember && remember ? { remember: true } : {})
    })
  return (
    <div className="sheet-backdrop" data-testid="ssh-prompt">
      <form
        className="sheet server-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-prompt-title"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="sheet-head">
          <h2 className="sheet-title" id="ssh-prompt-title">
            {title ?? 'Вопрос сервера'}
          </h2>
        </div>
        <div className="sheet-body">
          {prompt.kind === 'other' && <p className="server-prompt-text">{prompt.text}</p>}
          {prompt.retry && (
            <p className="server-retry" data-testid="ssh-retry">
              Пароль не подошёл
            </p>
          )}
          <input
            className="field"
            type={prompt.kind === 'other' ? 'text' : 'password'}
            data-testid="ssh-prompt-value"
            autoFocus
            maxLength={4096}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          {prompt.kind === 'passphrase' && (
            <p className="field-hint">Qclod его не запоминает. Чтобы не вводить каждый раз, добавьте ключ в ssh-agent.</p>
          )}
          {prompt.kind === 'password' && prompt.canRemember && (
            <label className="settings-toggle">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>Запомнить в системном хранилище</span>
            </label>
          )}
        </div>
        <div className="sheet-foot">
          <button type="button" className="btn btn-ghost" onClick={cancel}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" data-testid="ssh-prompt-ok">
            Войти
          </button>
        </div>
      </form>
    </div>
  )
}
