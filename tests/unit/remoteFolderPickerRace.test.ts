// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RemoteFolderPicker, RemoteFolderView, type DirListing } from '../../src/renderer/components/servers/RemoteFolderPicker'
import type { ServerView } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noop = (): void => undefined
const server: ServerView = {
  id: 'h1',
  label: 'Дом',
  target: 'me@home',
  auth: 'key',
  colour: 'green',
  recent: [],
  fromConfig: false,
  state: 'online',
  hasPassword: false
}
const listing: DirListing = {
  path: '~/projects',
  entries: [
    { name: 'app', kind: 'dir', size: 0, mtime: 0 },
    { name: 'linked', kind: 'link', size: 0, mtime: 0 }
  ],
  truncated: false
}

function view(over: Partial<Parameters<typeof RemoteFolderView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(RemoteFolderView, {
      server,
      listing,
      error: null,
      loading: false,
      typed: '~/projects',
      onType: noop,
      onGo: noop,
      onOpenHere: noop,
      onCancel: noop,
      ...over
    })
  )
}

const openHereDisabled = (html: string): boolean => /<button[^>]*data-testid="remote-open-here"[^>]*disabled=""/.test(html)

describe('выбор папки: ошибки, гонки, ссылки (Minor)', () => {
  test('после ошибки и пока поле не совпадает с показанной папкой «Открыть здесь» неактивна', () => {
    expect(openHereDisabled(view())).toBe(false)
    expect(openHereDisabled(view({ error: 'нет доступа', typed: '~/nope' }))).toBe(true)
    expect(openHereDisabled(view({ typed: '~/projects/ap' }))).toBe(true)
  })

  test('ссылка показана ссылкой, папка — папкой', () => {
    const html = view()
    expect(html).toMatch(/data-kind="link"[^>]*>.*linked/)
    expect(html).toMatch(/data-kind="dir"[^>]*>.*app/)
  })
})

describe('быстрые переходы', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  test('берётся только последний ответ', async () => {
    const pending = new Map<string, (l: DirListing) => void>()
    ;(window as unknown as { qclod: unknown }).qclod = {
      listServerDir: vi.fn((_h: string, path: string) => new Promise<DirListing>((res) => pending.set(path, res)))
    }
    act(() => root.render(createElement(RemoteFolderPicker, { server, onOpened: noop, onCancel: noop })))
    // ~ is asked first; then the person goes to /srv before it answers.
    const input = host.querySelector<HTMLInputElement>('[data-testid="remote-path"]')!
    const form = input.closest('form')!
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, '/srv')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await act(async () => pending.get('/srv')!({ path: '/srv', entries: [{ name: 'site', kind: 'dir', size: 0, mtime: 0 }], truncated: false }))
    await act(async () => pending.get('~')!({ path: '/home/me', entries: [{ name: 'old', kind: 'dir', size: 0, mtime: 0 }], truncated: false }))
    expect(input.value).toBe('/srv')
    expect(host.textContent).toContain('site')
    expect(host.textContent).not.toContain('old')
  })
})
