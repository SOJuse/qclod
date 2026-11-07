import { describe, expect, test } from 'vitest'
import { mayNotify, reduceStatus } from '@main/sessions/sessionStatus'
import type { SessionStatus } from '@shared/types'

const start = { status: 'idle' as SessionStatus, degraded: false }

describe('reduceStatus', () => {
  test('отправка сообщения переводит в busy', () => {
    expect(reduceStatus(start, { kind: 'sent' })).toEqual({ status: 'busy', degraded: false })
  })

  test('Stop переводит в idle', () => {
    const busy = { status: 'busy' as SessionStatus, degraded: false }
    expect(reduceStatus(busy, { kind: 'hook', event: { hook_event_name: 'Stop' } })).toEqual({
      status: 'idle',
      degraded: false
    })
  })

  test('Notification permission_prompt переводит в waiting', () => {
    expect(
      reduceStatus(start, {
        kind: 'hook',
        event: { hook_event_name: 'Notification', matcher: 'permission_prompt' }
      })
    ).toEqual({ status: 'waiting', degraded: false })
  })

  test('Notification agent_needs_input переводит в waiting', () => {
    expect(
      reduceStatus(start, {
        kind: 'hook',
        event: { hook_event_name: 'Notification', matcher: 'agent_needs_input' }
      }).status
    ).toBe('waiting')
  })

  test('Notification idle_prompt переводит в idle', () => {
    const busy = { status: 'busy' as SessionStatus, degraded: false }
    expect(
      reduceStatus(busy, {
        kind: 'hook',
        event: { hook_event_name: 'Notification', matcher: 'idle_prompt' }
      }).status
    ).toBe('idle')
  })

  test('PermissionRequest переводит в waiting', () => {
    expect(
      reduceStatus(start, { kind: 'hook', event: { hook_event_name: 'PermissionRequest' } }).status
    ).toBe('waiting')
  })

  test('SessionEnd переводит в exited', () => {
    expect(
      reduceStatus(start, { kind: 'hook', event: { hook_event_name: 'SessionEnd' } }).status
    ).toBe('exited')
  })

  test('неизвестное событие ничего не меняет', () => {
    const busy = { status: 'busy' as SessionStatus, degraded: false }
    expect(reduceStatus(busy, { kind: 'hook', event: { hook_event_name: 'PreToolUse' } })).toEqual(
      busy
    )
  })

  test('приход хука снимает пониженную достоверность', () => {
    const degraded = { status: 'busy' as SessionStatus, degraded: true }
    expect(
      reduceStatus(degraded, { kind: 'hook', event: { hook_event_name: 'Stop' } })
    ).toEqual({ status: 'idle', degraded: false })
  })

  test('таймаут в busy переводит в режим пониженной достоверности', () => {
    const busy = { status: 'busy' as SessionStatus, degraded: false }
    expect(reduceStatus(busy, { kind: 'timeout' })).toEqual({ status: 'idle', degraded: true })
  })

  test('таймаут вне busy ничего не меняет', () => {
    expect(reduceStatus(start, { kind: 'timeout' })).toEqual(start)
  })

  test('выход процесса переводит в exited', () => {
    expect(reduceStatus(start, { kind: 'exit' })).toEqual({ status: 'exited', degraded: false })
  })
})

describe('mayNotify', () => {
  test('о завершении в фоне уведомляем', () => {
    expect(mayNotify({ status: 'idle', degraded: false })).toBe(true)
  })

  test('об ожидании ответа уведомляем', () => {
    expect(mayNotify({ status: 'waiting', degraded: false })).toBe(true)
  })

  test('в режиме пониженной достоверности уведомления не шлются', () => {
    // Better silent than wrong: the status was guessed from output silence.
    expect(mayNotify({ status: 'idle', degraded: true })).toBe(false)
  })

  test('о работе и запуске не уведомляем', () => {
    expect(mayNotify({ status: 'busy', degraded: false })).toBe(false)
    expect(mayNotify({ status: 'starting', degraded: false })).toBe(false)
  })
})
