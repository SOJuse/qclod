// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FileViewer, VIEWER_TEXTS } from '../../src/renderer/components/viewer/FileViewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let finish: (v: 'opened' | null) => void
let fail: (e: Error) => void
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  api = {
    readForViewer: vi.fn(async () => ({ kind: 'binary', size: 10 })),
    downloadAndOpen: vi.fn(
      () =>
        new Promise((res, rej) => {
          finish = res
          fail = rej
        })
    )
  }
  ;(window as unknown as { qclod: unknown }).qclod = api
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const button = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[data-testid="viewer-open"]')!

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(FileViewer, { source: { kind: 'remote', hostId: 'h1' }, path: '/srv/a.bin', tabId: 't1', onClose: () => undefined }))
  })
}

describe('«Скачать и открыть» (Minor)', () => {
  test('ход виден, двойной щелчок не качает второй раз', async () => {
    await mount()
    act(() => button().click())
    act(() => button().click())
    expect(api.downloadAndOpen).toHaveBeenCalledTimes(1)
    expect(button().disabled).toBe(true)
    expect(button().textContent).toBe(VIEWER_TEXTS.downloading)
    await act(async () => finish('opened'))
    expect(button().disabled).toBe(false)
    expect(button().textContent).toBe(VIEWER_TEXTS.download)
  })

  test('отказ — понятный текст без «Error invoking…»; null — «не открылся»', async () => {
    await mount()
    act(() => button().click())
    await act(async () => fail(new Error("Error invoking remote method 'viewer:downloadOpen': Error: нет связи")))
    expect(host.querySelector('[data-testid="viewer-open-error"]')!.textContent).toBe('Не удалось скачать: нет связи')
    act(() => button().click())
    await act(async () => finish(null))
    expect(host.querySelector('[data-testid="viewer-open-error"]')!.textContent).toBe('Не удалось скачать: файл не открылся')
  })
})
