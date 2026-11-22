// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PathLink } from '../../src/renderer/paths/PathLink'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import type { ResolvedPath, TabState } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let api: Record<string, ReturnType<typeof vi.fn>>
let copied: string[]

function setup(target: ResolvedPath, server: boolean): HTMLElement {
  const tab = { id: 't1', cwd: '/srv/app', title: 'x', overrides: {}, status: 'idle', badge: false, ...(server ? { server: { hostId: 'h1' } } : {}) } as TabState
  useAppStore.setState({ tabs: [tab], layerByTab: {} })
  api = { resolvePaths: vi.fn(async () => [target]), openPath: vi.fn(async () => 'opened') }
  ;(window as unknown as { qclod: unknown }).qclod = api
  copied = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (t: string) => void copied.push(t)) } })
  act(() => root.render(createElement(PathLink, { tabId: 't1', target, children: target.raw })))
  return host.querySelector<HTMLElement>('[data-testid="path-link"]')!
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('щелчок по пути в серверном чате (R7)', () => {
  test('файл — слой просмотра на нужной строке; открыть «здесь» не пытается', async () => {
    const target: ResolvedPath = { raw: 'src/a.ts:12', absPath: '/srv/app/src/a.ts', isDir: false, line: 12 }
    const link = setup(target, true)
    act(() => link.click())
    await flush()
    expect(useAppStore.getState().layerByTab['t1']).toEqual({ kind: 'file', path: '/srv/app/src/a.ts', line: 12 })
    expect(api.openPath).not.toHaveBeenCalled()
  })

  test('папка — путь копируется', async () => {
    const target: ResolvedPath = { raw: 'src/', absPath: '/srv/app/src', isDir: true }
    const link = setup(target, true)
    act(() => link.click())
    await flush()
    expect(copied).toEqual(['/srv/app/src'])
    expect(useAppStore.getState().layerByTab['t1'] ?? null).toBeNull()
    expect(api.openPath).not.toHaveBeenCalled()
  })

  test('локальный чат — как прежде, открывает программой', async () => {
    const target: ResolvedPath = { raw: 'a.ts', absPath: 'C:/p/a.ts', isDir: false }
    const link = setup(target, false)
    act(() => link.click())
    await flush()
    expect(api.openPath).toHaveBeenCalledWith('t1', 'C:/p/a.ts')
  })
})
