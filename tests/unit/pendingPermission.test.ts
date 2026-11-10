import { describe, expect, test } from 'vitest'
import { oldestPendingPermission } from '@renderer/chat/pendingPermission'
import type { RibbonItem } from '@shared/types'

function perm(id: string, state: 'pending' | 'allowed' | 'denied'): RibbonItem {
  return {
    id,
    kind: 'permission',
    requestId: `r-${id}`,
    toolName: 'Bash',
    target: 'npm test',
    state
  } as RibbonItem
}

describe('oldestPendingPermission', () => {
  test('нет карточек — null', () => {
    expect(oldestPendingPermission([])).toBeNull()
  })

  test('отвеченные не считаются', () => {
    expect(oldestPendingPermission([perm('a', 'allowed'), perm('b', 'denied')])).toBeNull()
  })

  test('из нескольких ожидающих берётся самая ранняя', () => {
    const found = oldestPendingPermission([perm('a', 'allowed'), perm('b', 'pending'), perm('c', 'pending')])
    expect(found?.id).toBe('b')
  })

  test('карточка внутри субагента (parentId) не берётся', () => {
    const inner = { ...perm('x', 'pending'), parentId: 'sub' } as RibbonItem
    expect(oldestPendingPermission([inner, perm('b', 'pending')])?.id).toBe('b')
  })
})
