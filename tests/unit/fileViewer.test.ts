// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { FileViewerView, VIEWER_TEXTS } from '../../src/renderer/components/viewer/FileViewer'
import { PathMenu } from '../../src/renderer/paths/PathMenu'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import type { ResolvedPath, TabState, ViewerContent } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')

function markup(content: ViewerContent | null, line?: number, remote = false): string {
  return renderToStaticMarkup(
    createElement(FileViewerView, {
      source: remote ? { kind: 'remote', hostId: 'h1' } : { kind: 'local' },
      path: '/p/a.ts',
      line,
      content,
      onOpen: () => undefined,
      onClose: () => undefined
    })
  )
}

const text = (t: string, truncated = false): ViewerContent => ({ kind: 'text', text: t, language: 'typescript', size: t.length, truncated })

describe('FileViewer', () => {
  test('только просмотр: нет textarea и contenteditable', () => {
    const html = markup(text(TEN))
    expect(html).toContain(VIEWER_TEXTS.readOnly)
    expect(html).not.toMatch(/<textarea|contenteditable/i)
    expect(html).toContain(VIEWER_TEXTS.openLocal)
    expect(markup(text(TEN), undefined, true)).toContain(VIEWER_TEXTS.download)
  })

  test('line: 3 — третья строка с data-line-mark; line: 999 — отметки нет', () => {
    const marked = markup(text(TEN), 3)
    const lines = [...marked.matchAll(/<div class="viewer-line" data-line="(\d+)"( data-line-mark="")?/g)]
    expect(lines).toHaveLength(10)
    expect(lines.filter((m) => m[2]).map((m) => m[1])).toEqual(['3'])
    expect(markup(text(TEN), 999)).not.toContain('data-line-mark')
  })

  test('тексты: обрезано, не текст, ошибка', () => {
    expect(markup(text('a', true))).toContain('Файл больше 2 МБ — показано начало')
    expect(markup({ kind: 'binary', size: 2048 })).toContain('Это не текст (2 КБ)')
    expect(markup({ kind: 'error', message: 'нет доступа' })).toContain('Не удалось прочитать файл: нет доступа')
  })
})

describe('PathMenu «Посмотреть»', () => {
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

  function open(target: ResolvedPath, server?: { hostId: string }): HTMLButtonElement[] {
    const tab = { id: 't1', cwd: '/p', title: 'x', overrides: {}, status: 'idle', badge: false, ...(server ? { server } : {}) } as TabState
    useAppStore.setState({ tabs: [tab], layerByTab: {} })
    ;(window as unknown as { qclod: unknown }).qclod = {
      resolvePaths: vi.fn(async () => [target]),
      downloadAndOpen: vi.fn(async () => 'opened'),
      openPath: vi.fn(async () => 'opened')
    }
    act(() => root.render(createElement(PathMenu, { tabId: 't1', target, x: 10, y: 10, onClose: () => undefined })))
    return [...document.querySelectorAll<HTMLButtonElement>('[data-testid="path-menu-item"]')]
  }

  test('у src/a.ts:3 ставит слой {kind:file, path, line:3}', async () => {
    const target: ResolvedPath = { raw: 'src/a.ts:3', absPath: '/p/src/a.ts', isDir: false, line: 3 }
    const items = open(target)
    const view = items.find((b) => b.textContent === 'Посмотреть')!
    expect(view).toBeTruthy()
    await act(async () => {
      view.click()
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(useAppStore.getState().layerByTab['t1']).toEqual({ kind: 'file', path: '/p/src/a.ts', line: 3 })
  })

  test('серверная вкладка: Посмотреть, Скачать и открыть, Копировать путь', () => {
    const items = open({ raw: 'a.ts', absPath: '/srv/a.ts', isDir: false }, { hostId: 'h1' })
    expect(items.map((b) => b.textContent)).toEqual(['Посмотреть', 'Скачать и открыть', 'Копировать путь'])
  })
})
