import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { SshPromptDialog } from '../../src/renderer/components/servers/SshPromptDialog'
import type { SshPrompt } from '../../src/shared/types'

const html = (prompt: SshPrompt): string => renderToStaticMarkup(createElement(SshPromptDialog, { prompt, onAnswer: () => undefined }))

describe('вопрос ssh после ревью', () => {
  test('R6: отпечаток не разобран — нет «Доверять», показан текст ssh', () => {
    const noPrint = html({ promptId: 'p', hostId: 'h', kind: 'hostKey', host: 'box', keyType: 'ED25519', fingerprint: '' })
    expect(noPrint).not.toContain('data-testid="ssh-trust"')
    expect(noPrint).toContain('не смог разобрать отпечаток')
    const noType = html({ promptId: 'p', hostId: 'h', kind: 'hostKey', host: 'box', keyType: ' ', fingerprint: 'MD5:aa:bb' })
    expect(noType).not.toContain('Доверять')
    const raw = html({
      promptId: 'p',
      hostId: 'h',
      kind: 'hostKey',
      host: 'box',
      keyType: '',
      fingerprint: '',
      text: 'The authenticity of host box can not be established. <b>x</b>'
    } as SshPrompt)
    expect(raw).toContain('The authenticity of host box can not be established. &lt;b&gt;x&lt;/b&gt;')
    expect(raw).not.toContain('Доверять')
    // A readable one keeps «Доверять».
    expect(html({ promptId: 'p', hostId: 'h', kind: 'hostKey', host: 'box', keyType: 'ED25519', fingerprint: 'SHA256:x' })).toContain('Доверять')
  })

  test('вопрос вида other — поле скрыто (password) с «Показать»; пароль — без «Показать»', () => {
    const other = html({ promptId: 'p', hostId: 'h', kind: 'other', text: 'Verification code:', canRemember: false, retry: false })
    expect(other).toMatch(/<input[^>]*type="password"[^>]*data-testid="ssh-prompt-value"/)
    expect(other).toContain('Показать')
    const password = html({ promptId: 'p', hostId: 'h', kind: 'password', text: 'me@box', canRemember: false, retry: false })
    expect(password).not.toContain('data-testid="ssh-prompt-show"')
  })
})
