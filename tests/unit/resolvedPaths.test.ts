import { afterEach, describe, expect, test, vi } from 'vitest'
import { freshTarget } from '../../src/renderer/paths/useResolvedPaths'
import { useAppStore } from '../../src/renderer/state/useAppStore'
import type { ResolvedPath } from '../../src/shared/types'

const g = globalThis as { window?: unknown }
const hit: ResolvedPath = { raw: 'src/a.ts', absPath: 'C:/p/src/a.ts', isDir: false }

afterEach(() => {
  delete g.window
})

describe('freshTarget', () => {
  test('ответ main заменяет запомненный', async () => {
    g.window = { qclod: { resolvePaths: vi.fn(async () => [null]) } }
    useAppStore.getState().setPaths('F1', [['src/a.ts', hit]])
    expect(await freshTarget('F1', hit)).toBeNull()
    expect(useAppStore.getState().pathsByTab['F1']!.get('src/a.ts')?.target).toBeNull()
  })

  test('сбой вызова не стирает запомненное: ничего не делается, ссылка остаётся', async () => {
    g.window = { qclod: { resolvePaths: vi.fn(async () => Promise.reject(new Error('ipc'))) } }
    useAppStore.getState().setPaths('F2', [['src/a.ts', hit]])
    expect(await freshTarget('F2', hit)).toBeNull()
    expect(useAppStore.getState().pathsByTab['F2']!.get('src/a.ts')?.target).toEqual(hit)
  })
})
