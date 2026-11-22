import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { ServerAccount, ServerLoginView, safeLoginUrl } from '../../src/renderer/components/servers/ServerLoginDialog'
import type { ServerView } from '../../src/shared/types'

const noop = (): void => undefined
const base: ServerView = {
  id: 'h1',
  label: 'Дом',
  target: 'me@home',
  auth: 'key',
  colour: 'blue',
  recent: [],
  fromConfig: false,
  state: 'online',
  hasPassword: false
}
const text = (html: string): string => html.replace(/<[^>]+>/g, '')

describe('аккаунт сервера', () => {
  test('разметка блока аккаунта в трёх состояниях: вошёл, не вошёл, неизвестно', () => {
    const inside = text(
      renderToStaticMarkup(
        createElement(ServerAccount, {
          server: { ...base, account: { loggedIn: true, email: 'me@x.io', plan: 'Max', claudePath: '/c', claudeVersion: '2.1.317' } },
          onLogin: noop
        })
      )
    )
    expect(inside).toContain('Сервер: Дом')
    expect(inside).toContain('Аккаунт: me@x.io · Max')
    expect(inside).not.toContain('Войти')

    const out = text(
      renderToStaticMarkup(
        createElement(ServerAccount, {
          server: { ...base, account: { loggedIn: false, claudePath: '/c', claudeVersion: '2.1.317' } },
          onLogin: noop
        })
      )
    )
    expect(out).toContain('Вход не выполнен')
    expect(out).toContain('Войти')

    const unknown = text(renderToStaticMarkup(createElement(ServerAccount, { server: base, onLogin: noop })))
    expect(unknown).toContain('Аккаунт: не удалось узнать')
  })

  test('диалог входа: шаги, успех и ошибка; ссылка открывается только https', () => {
    const view = (progress: Parameters<typeof ServerLoginView>[0]['progress']): string =>
      text(
        renderToStaticMarkup(
          createElement(ServerLoginView, { server: base, progress, onOpenLink: noop, onCode: noop, onRetry: noop, onClose: noop })
        )
      )
    const waiting = view({ state: 'waitingCode', url: 'https://claude.ai/oauth/authorize?x=1' })
    expect(waiting).toContain('Вход в Claude на сервере Дом')
    expect(waiting).toContain('1. Откройте ссылку и войдите в аккаунт, которым пользуется сервер')
    expect(waiting).toContain('Открыть ссылку')
    expect(waiting).toContain('2. Вставьте код из браузера')
    expect(waiting).toContain('Готово')
    expect(view({ state: 'done', email: 'me@x.io' })).toContain('Вход выполнен: me@x.io')
    const failed = view({ state: 'failed', error: 'неверный код' })
    expect(failed).toContain('Войти не получилось: неверный код')
    expect(failed).toContain('Ещё раз')
    expect(safeLoginUrl('http://claude.ai/x')).toBeNull()
    expect(safeLoginUrl('javascript:alert(1)')).toBeNull()
    expect(safeLoginUrl('https://claude.ai/x')).toBe('https://claude.ai/x')
  })
})
