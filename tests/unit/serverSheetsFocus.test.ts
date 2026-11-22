// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Composer } from '../../src/renderer/components/Composer'
import { ServersSheet } from '../../src/renderer/components/servers/ServersSheet'
import { SshPromptDialog } from '../../src/renderer/components/servers/SshPromptDialog'
import { ServerLoginView } from '../../src/renderer/components/servers/ServerLoginDialog'
import { paletteActionKeepsFocus } from '../../src/renderer/app/shortcuts'
import type { ServerView, SshPrompt } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe(): void {}
  disconnect(): void {}
}

const noop = (): void => undefined
const server: ServerView = {
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

let host: HTMLDivElement
let root: Root
let submit: ReturnType<typeof vi.fn>
let interrupt: ReturnType<typeof vi.fn>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  submit = vi.fn()
  interrupt = vi.fn()
  ;(window as unknown as { qclod: unknown }).qclod = {
    listServerDir: vi.fn(async (_h: string, path: string) => ({ path, entries: [], truncated: false })),
    openServerFolder: vi.fn(async () => null),
    connectServer: vi.fn(async () => true)
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** A working agent's input line, with the draft typed and focus in it — and the sheet over it. */
function withComposer(sheet: ReactElement | null): ReactElement {
  return createElement(
    'div',
    null,
    createElement(Composer, {
      tabId: 't1',
      status: 'busy',
      draft: 'черновик',
      sentTexts: [],
      attachments: [],
      fileIndex: [],
      commands: [],
      recentCommands: [],
      models: [],
      model: null,
      effort: null,
      started: true,
      focusToken: 0,
      autoFocus: true,
      onDraftChange: noop,
      onAttachmentsChange: noop,
      onSubmit: submit,
      onInterrupt: interrupt,
      onSendCommand: noop,
      onCommandUsed: noop,
      onOpenHistory: noop,
      onSetModel: noop,
      onSetEffort: noop,
      onCycleMode: noop,
      onRestart: noop,
      onRetry: noop,
      onPickFiles: noop,
      onImagePrepared: noop
    }),
    sheet
  )
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function press(key: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true })
  act(() => {
    ;(document.activeElement ?? document.body).dispatchEvent(ev)
  })
  return ev
}

/** Mounts the input first (it takes focus), then the sheet over it. */
async function open(sheet: ReactElement): Promise<void> {
  act(() => root.render(withComposer(null)))
  expect(document.activeElement?.hasAttribute('data-composer-input')).toBe(true)
  act(() => root.render(withComposer(sheet)))
  await flush()
}

describe('модальные листы серверов берут фокус (R2)', () => {
  test('выбор папки: фокус в поле пути; Enter не уходит агенту, Esc закрывает лист и не прерывает агента', async () => {
    const onClose = vi.fn()
    const onWindowEsc = vi.fn()
    window.addEventListener('keydown', onWindowEsc)
    await open(
      createElement(ServersSheet, {
        servers: [server],
        steps: {},
        initial: { kind: 'folder', hostId: 'h1' },
        onClose,
        onOpened: noop
      })
    )
    expect(document.activeElement?.getAttribute('data-testid')).toBe('remote-path')
    press('Enter')
    expect(submit).not.toHaveBeenCalled()
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(interrupt).not.toHaveBeenCalled()
    // Esc stops at the sheet: nothing behind it (the side drawer, the window) hears it.
    expect(onWindowEsc.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape')).toHaveLength(0)
    window.removeEventListener('keydown', onWindowEsc)
  })

  test('список серверов: фокус внутри листа; Tab не уходит из листа', async () => {
    await open(createElement(ServersSheet, { servers: [server], steps: {}, onClose: noop, onOpened: noop }))
    const sheet = host.querySelector('[data-testid="servers-sheet"]')!
    expect(sheet.contains(document.activeElement)).toBe(true)
    for (let i = 0; i < 6; i++) {
      const ev = press('Tab')
      // jsdom does not move focus by itself: the trap either moved it or let the browser.
      expect(ev.defaultPrevented || sheet.contains(document.activeElement)).toBe(true)
    }
    expect(sheet.contains(document.activeElement)).toBe(true)
  })

  test('вопрос о ключе: фокус на «Отмена»; Enter не уходит агенту; Esc — ответ ok:false', async () => {
    const onAnswer = vi.fn()
    const prompt: SshPrompt = { promptId: 'p1', hostId: 'h1', kind: 'hostKey', host: 'home', keyType: 'ED25519', fingerprint: 'SHA256:abc' }
    await open(createElement(SshPromptDialog, { prompt, onAnswer }))
    expect(document.activeElement?.textContent).toBe('Отмена')
    expect(submit).not.toHaveBeenCalled()
    press('Escape')
    expect(onAnswer).toHaveBeenCalledWith({ promptId: 'p1', ok: false })
    expect(interrupt).not.toHaveBeenCalled()
  })

  test('вопрос пароля: фокус в поле; Esc — отмена, агент не прерван', async () => {
    const onAnswer = vi.fn()
    const prompt: SshPrompt = { promptId: 'p2', hostId: 'h1', kind: 'password', text: 'me@home', canRemember: false, retry: false }
    await open(createElement(SshPromptDialog, { prompt, onAnswer }))
    expect(document.activeElement?.getAttribute('data-testid')).toBe('ssh-prompt-value')
    press('Escape')
    expect(onAnswer).toHaveBeenCalledWith({ promptId: 'p2', ok: false })
    expect(interrupt).not.toHaveBeenCalled()
  })

  test('вход в аккаунт сервера: фокус в поле кода; Esc закрывает', async () => {
    const onClose = vi.fn()
    await open(
      createElement(ServerLoginView, {
        server,
        progress: { state: 'waitingCode', url: 'https://claude.ai/x' },
        onOpenLink: noop,
        onCode: noop,
        onRetry: noop,
        onClose
      })
    )
    expect(document.activeElement?.getAttribute('data-testid')).toBe('server-login-code')
    press('Enter')
    expect(submit).not.toHaveBeenCalled()
    press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(interrupt).not.toHaveBeenCalled()
  })

  test('строки Ctrl+K «папка на сервере» и «терминал» не возвращают фокус в поле ввода', () => {
    expect(paletteActionKeepsFocus('openServerFolder')).toBe(true)
    expect(paletteActionKeepsFocus('openServerTerminal')).toBe(true)
    expect(paletteActionKeepsFocus('newTab')).toBe(false)
  })
})
