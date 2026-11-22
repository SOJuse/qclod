import { useEffect, useRef, useState } from 'react'
import type { SshPrompt, SshPromptAnswer } from '../../../shared/types'
import { useModalSheet } from '../../ui/modalFocus'

interface Props {
  prompt: SshPrompt
  onAnswer: (answer: SshPromptAnswer) => void
}

type HostKeyPrompt = Extract<SshPrompt, { kind: 'hostKey' }>

/** A host-key question Qclod could read: both the key's type and its fingerprint are there. */
export function hostKeyReadable(prompt: HostKeyPrompt): boolean {
  return prompt.fingerprint.trim() !== '' && prompt.keyType.trim() !== ''
}

/**
 * What a host-key question says when Qclod could not read it (R6): ssh's own
 * words if they came, else that much. No «Доверять» then — there is nothing
 * to check it against.
 */
function unreadableText(prompt: HostKeyPrompt): string {
  const raw = (prompt as HostKeyPrompt & { text?: unknown }).text
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  return `ssh спрашивает о ключе сервера ${prompt.host}, но Qclod не смог разобрать отпечаток. Сверьте ключ на сервере сами.`
}

/**
 * A question ssh asked, put to the person. Its text came from the server
 * (keyboard-interactive): it is shown as plain text, never as markup.
 *
 * Modal (R2): focus comes in at once — on «Отмена» for a host key, in the
 * field otherwise — so Enter never reaches the input line behind; Esc
 * cancels (ok: false) and goes no further; Tab stays inside.
 */
export function SshPromptDialog({ prompt, onAnswer }: Props): JSX.Element {
  const [value, setValue] = useState('')
  const [remember, setRemember] = useState(prompt.kind === 'password' && prompt.canRemember)
  const [visible, setVisible] = useState(false)
  const cancel = (): void => onAnswer({ promptId: prompt.promptId, ok: false })
  const sheet = useRef<HTMLElement | null>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const onKeyDown = useModalSheet(sheet, cancel)
  const trustable = prompt.kind === 'hostKey' && hostKeyReadable(prompt)
  const setSheet = (el: HTMLElement | null): void => {
    sheet.current = el
  }

  useEffect(() => {
    if (trustable) cancelButton.current?.focus()
    else field.current?.focus()
  }, [trustable])

  if (prompt.kind === 'hostKey' && trustable) {
    const type = prompt.keyType.toLowerCase()
    return (
      <div className="sheet-backdrop server-prompt-backdrop" data-testid="ssh-prompt">
        <div
          ref={setSheet}
          className="sheet server-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ssh-prompt-title"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
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
            <button ref={cancelButton} type="button" className="btn btn-ghost" onClick={cancel}>
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

  // A host key Qclod could not read is put as ssh's own question (R6).
  const text = prompt.kind === 'hostKey' ? unreadableText(prompt) : prompt.kind === 'other' ? prompt.text : null
  const title =
    prompt.kind === 'password'
      ? `Пароль для ${prompt.text}`
      : prompt.kind === 'passphrase'
        ? `Пароль от ключа ${prompt.text}`
        : null
  const canRemember = prompt.kind === 'password' && prompt.canRemember
  const retry = prompt.kind !== 'hostKey' && prompt.retry
  // A question of its own kind may well want a secret too: hidden, with «Показать».
  const free = prompt.kind === 'other' || prompt.kind === 'hostKey'
  const submit = (): void =>
    onAnswer({
      promptId: prompt.promptId,
      ok: true,
      value,
      ...(canRemember && remember ? { remember: true } : {})
    })
  return (
    <div className="sheet-backdrop server-prompt-backdrop" data-testid="ssh-prompt">
      <form
        ref={setSheet}
        className="sheet server-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-prompt-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
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
          {text !== null && (
            <p className="server-prompt-text" data-testid="ssh-prompt-text">
              {text}
            </p>
          )}
          {retry && (
            <p className="server-retry" data-testid="ssh-retry">
              Пароль не подошёл
            </p>
          )}
          <div className="server-prompt-field">
            <input
              ref={field}
              className="field"
              type={free && visible ? 'text' : 'password'}
              data-testid="ssh-prompt-value"
              maxLength={4096}
              spellCheck={false}
              autoComplete="off"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            {free && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                data-testid="ssh-prompt-show"
                aria-pressed={visible}
                onClick={() => setVisible((v) => !v)}
              >
                {visible ? 'Скрыть' : 'Показать'}
              </button>
            )}
          </div>
          {prompt.kind === 'passphrase' && (
            <p className="field-hint">Qclod его не запоминает. Чтобы не вводить каждый раз, добавьте ключ в ssh-agent.</p>
          )}
          {canRemember && (
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
