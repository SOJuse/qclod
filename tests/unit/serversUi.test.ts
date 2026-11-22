import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AddServerForm } from '../../src/renderer/components/servers/AddServerForm'
import { ConnectChecklist } from '../../src/renderer/components/servers/ConnectChecklist'
import { ServerPicker } from '../../src/renderer/components/servers/ServerPicker'
import { SshPromptDialog } from '../../src/renderer/components/servers/SshPromptDialog'
import { canRememberPasswords } from '../../src/renderer/components/servers/ServersSheet'
import type { ConnectStep, ServerView, SshPrompt } from '../../src/shared/types'

const noop = (): void => undefined

function server(over: Partial<ServerView> = {}): ServerView {
  return {
    id: 'h1',
    label: 'Дом',
    target: 'me@home',
    auth: 'key',
    colour: 'blue',
    recent: [],
    fromConfig: false,
    state: 'idle',
    hasPassword: false,
    ...over
  }
}

type TextPrompt = Extract<SshPrompt, { kind: 'password' | 'passphrase' | 'other' }>
const prompt = (p: Partial<TextPrompt> & { kind: TextPrompt['kind'] }): SshPrompt =>
  ({ promptId: 'p1', hostId: 'h1', text: 'me@home', canRemember: true, retry: false, ...p }) as SshPrompt

const html = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el)
/** Text without markup: what the person reads. */
const text = (markup: string): string => markup.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')

describe('экраны серверов', () => {
  test('список: группы «Недавние» (хост + папка), «Из ~/.ssh/config», «Добавить сервер»', () => {
    const out = html(
      createElement(ServerPicker, {
        servers: [server({ recent: ['/srv/app'] }), server({ id: 'h2', label: 'gw', target: 'gw', fromConfig: true })],
        onPick: noop,
        onPickRecent: noop,
        onAdd: noop
      })
    )
    const t = text(out)
    expect(t).toContain('Недавние')
    expect(t).toContain('Из ~/.ssh/config')
    expect(t).toContain('Добавить сервер')
    expect(t.indexOf('Недавние')).toBeLessThan(t.indexOf('Из ~/.ssh/config'))
    expect(t).toContain('/srv/app')
    expect(out).toContain('data-colour="blue"')
    expect(out).not.toContain('style=')
  })

  test('форма: подписи и кнопки дословно', () => {
    const key = text(html(createElement(AddServerForm, { canRemember: true, onSubmit: noop })))
    for (const s of [
      'Имя (необязательно)',
      'Хост — user@host или имя из ~/.ssh/config',
      'Порт',
      'Ключ (необязательно, иначе ssh-agent)',
      'Ключ',
      'Пароль',
      'Проверить соединение',
      'Сохранить'
    ]) {
      expect(key).toContain(s)
    }
    const pw = text(html(createElement(AddServerForm, { canRemember: true, onSubmit: noop, initial: server({ auth: 'password' }) })))
    expect(pw).toContain('Запомнить в системном хранилище')
    expect(pw).not.toContain('Системное хранилище недоступно')
  })

  test('hasPassword:false и box.available() === false — галочка выключена с подписью', () => {
    const servers = [server({ auth: 'password', hasPassword: false, canStorePassword: false })]
    expect(canRememberPasswords(servers)).toBe(false)
    const out = html(
      createElement(AddServerForm, { canRemember: canRememberPasswords(servers), onSubmit: noop, initial: servers[0] })
    )
    expect(out).toMatch(/data-testid="server-remember"[^>]*disabled|disabled[^>]*data-testid="server-remember"/)
    expect(text(out)).toContain('Системное хранилище недоступно')
  })

  test('ключ сервера: заголовок, текст, отпечаток моноширинным, сверка, «Доверять» и «Отмена»', () => {
    const out = html(
      createElement(SshPromptDialog, {
        prompt: {
          promptId: 'p1',
          hostId: 'h1',
          kind: 'hostKey',
          host: 'home.lan',
          keyType: 'ED25519',
          fingerprint: 'SHA256:d7Te2DHmvBNSWJNBWik2KbDTjmWtYHe2bvXTMM9lVg4'
        },
        onAnswer: noop
      })
    )
    const t = text(out)
    expect(t).toContain('Новый сервер: проверьте ключ')
    expect(t).toContain('Qclod впервые подключается к home.lan. Отпечаток ключа (ED25519):')
    expect(out).toMatch(/<code[^>]*>SHA256:d7Te2DHmvBNSWJNBWik2KbDTjmWtYHe2bvXTMM9lVg4<\/code>/)
    expect(t).toContain('Сверьте его на самом сервере: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub')
    expect(t).toContain('Доверять')
    expect(t).toContain('Отмена')
  })

  test('пароль: «Пароль для user@host», при retry — «Пароль не подошёл»; кнопки «Войти» / «Отмена»', () => {
    const first = text(html(createElement(SshPromptDialog, { prompt: prompt({ kind: 'password' }), onAnswer: noop })))
    expect(first).toContain('Пароль для me@home')
    expect(first).not.toContain('Пароль не подошёл')
    expect(first).toContain('Войти')
    expect(first).toContain('Отмена')
    const again = text(html(createElement(SshPromptDialog, { prompt: prompt({ kind: 'password', retry: true }), onAnswer: noop })))
    expect(again).toContain('Пароль не подошёл')
  })

  test('пароль от ключа и прочий вопрос как простой текст', () => {
    const pass = text(
      html(createElement(SshPromptDialog, { prompt: prompt({ kind: 'passphrase', text: 'C:\\keys\\id_ed25519', canRemember: false }), onAnswer: noop }))
    )
    expect(pass).toContain('Пароль от ключа C:\\keys\\id_ed25519')
    expect(pass).toContain('Qclod его не запоминает. Чтобы не вводить каждый раз, добавьте ключ в ssh-agent.')
    expect(pass).not.toContain('Запомнить в системном хранилище')
    const other = html(
      createElement(SshPromptDialog, { prompt: prompt({ kind: 'other', text: '<b>Код</b> & "SMS":', canRemember: false }), onAnswer: noop })
    )
    expect(other).not.toContain('<b>')
    expect(other).toContain('&lt;b&gt;Код&lt;/b&gt; &amp;')
  })

  test('у hostKeyChanged нет кнопки «Доверять»; чек-лист — пять шагов и «Проверить снова»', () => {
    const problem =
      'Ключ сервера home.lan изменился. Это может быть подмена, поэтому Qclod не подключается. ' +
      'Если сервер переустанавливали, удалите старый ключ: ssh-keygen -R home.lan -f "C:\\Users\\me\\AppData\\Roaming\\Qclod\\ssh\\known_hosts"'
    const steps: ConnectStep[] = [
      { id: 'ssh', state: 'fail', text: 'Связь с сервером', hint: problem },
      { id: 'auth', state: 'pending', text: 'Вход' },
      { id: 'claude', state: 'pending', text: 'Claude Code на сервере' },
      { id: 'relay', state: 'pending', text: 'Посредник Qclod' },
      { id: 'login', state: 'pending', text: 'Аккаунт Claude' }
    ]
    const out = html(createElement(ConnectChecklist, { steps, problem, onRetry: noop }))
    const t = text(out)
    expect(t).not.toContain('Доверять')
    expect(t).toContain('Ключ сервера home.lan изменился.')
    expect(t).toContain('Проверить снова')
    expect(out.match(/data-step="/g)).toHaveLength(5)
    expect(out).toContain('data-state="fail"')
    // Before anything has run: the same five, pending.
    const empty = html(createElement(ConnectChecklist, { onRetry: noop }))
    expect(text(empty)).toContain('Связь с сервером')
    expect(empty.match(/data-state="pending"/g)).toHaveLength(5)
  })
})
