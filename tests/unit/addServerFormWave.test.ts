import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { AddServerForm } from '../../src/renderer/components/servers/AddServerForm'
import type { ServerView } from '../../src/shared/types'

const initial = { id: 'h1', label: 'Дом', target: 'me@home', auth: 'password', colour: 'blue', recent: [], fromConfig: false, state: 'idle', hasPassword: false } as ServerView

describe('пароль без «Запомнить» (Minor)', () => {
  test('хранилища нет — поля пароля нет, подпись «Пароль спросят при подключении»', () => {
    const html = renderToStaticMarkup(createElement(AddServerForm, { canRemember: false, onSubmit: () => undefined, initial }))
    expect(html).not.toContain('data-testid="server-password"')
    expect(html).toContain('Пароль спросят при подключении')
  })

  test('с «Запомнить» — поле есть, подписи нет', () => {
    const html = renderToStaticMarkup(createElement(AddServerForm, { canRemember: true, onSubmit: () => undefined, initial }))
    expect(html).toContain('data-testid="server-password"')
    expect(html).not.toContain('Пароль спросят при подключении')
  })
})
