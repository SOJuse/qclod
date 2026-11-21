import { describe, expect, test } from 'vitest'
import { RelayGate } from '../../src/relay/gate'
import type { PermissionRule } from '../../src/main/agent/permissionStore'
import type { PermissionMode } from '../../src/shared/types'
import type { PermResolved, RelayPending } from '../../src/shared/relayProtocol'

function gate(mode: PermissionMode, rules: PermissionRule[] = []): {
  gate: RelayGate
  asked: RelayPending[]
  resolved: PermResolved[]
} {
  const g = new RelayGate({ rules: () => rules, mode: () => mode, now: () => 42 })
  const asked: RelayPending[] = []
  const resolved: PermResolved[] = []
  g.onAsked((p) => asked.push(p))
  g.onResolved((r) => resolved.push(r))
  return { gate: g, asked, resolved }
}

describe('шлюз разрешений посредника', () => {
  test('правило deny побеждает autoAllow', async () => {
    const { gate: g, asked } = gate('autoAllow', [
      { id: 'r', toolName: 'Bash', target: 'rm -rf /', behavior: 'deny' }
    ])
    const answer = await g.request('Bash', { command: 'rm -rf /' }, { toolUseId: 't1' })
    expect(answer.behavior).toBe('deny')
    expect(asked).toEqual([])
  })

  test('правило allow решает сразу и без авто-да', async () => {
    const { gate: g, asked } = gate('default', [{ id: 'r', toolName: 'Read', behavior: 'allow' }])
    expect(await g.request('Read', { file_path: '/a' }, {})).toEqual({ behavior: 'allow' })
    expect(asked).toEqual([])
  })

  test('autoAllow разрешает Bash, но AskUserQuestion и ExitPlanMode ждут', async () => {
    const { gate: g, asked } = gate('autoAllow')
    expect(await g.request('Bash', { command: 'ls' }, { toolUseId: 't1' })).toEqual({ behavior: 'allow' })
    let settled = false
    const question = g.request('AskUserQuestion', { questions: [] }, { toolUseId: 'q1' }).then((a) => {
      settled = true
      return a
    })
    void g.request('ExitPlanMode', { plan: 'x' }, { toolUseId: 'p1' })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(asked.map((p) => p.toolName)).toEqual(['AskUserQuestion', 'ExitPlanMode'])
    expect(asked[0]).toEqual({
      requestId: 'q1',
      toolName: 'AskUserQuestion',
      input: { questions: [] },
      toolUseId: 'q1',
      askedAt: 42
    })
    expect(g.pending().map((p) => p.requestId)).toEqual(['q1', 'p1'])
    expect(g.answer('q1', { behavior: 'allow', updatedInput: { answers: { a: 'b' } } }, 'client')).toBe(true)
    expect(await question).toEqual({ behavior: 'allow', updatedInput: { answers: { a: 'b' } } })
  })

  test('два answer — второй даёт false', async () => {
    const { gate: g, resolved } = gate('default')
    const asked = g.request('Bash', { command: 'ls' }, { toolUseId: 't1' })
    expect(g.answer('t1', { behavior: 'allow' }, 'client')).toBe(true)
    expect(g.answer('t1', { behavior: 'deny' }, 'client')).toBe(false)
    expect(await asked).toEqual({ behavior: 'allow' })
    expect(resolved).toEqual([{ requestId: 't1', by: 'client', answer: { behavior: 'allow' } }])
    expect(g.pending()).toEqual([])
  })

  test('abort сигнала даёт deny и by:elsewhere', async () => {
    const { gate: g, resolved } = gate('default')
    const controller = new AbortController()
    const asked = g.request('Bash', { command: 'ls' }, { toolUseId: 't1', signal: controller.signal })
    controller.abort()
    expect(await asked).toEqual({ behavior: 'deny' })
    expect(resolved).toEqual([{ requestId: 't1', by: 'elsewhere' }])
    expect(g.answer('t1', { behavior: 'allow' }, 'client')).toBe(false)
  })

  test('уже прерванный сигнал — deny без карточки', async () => {
    const { gate: g, asked } = gate('default')
    const controller = new AbortController()
    controller.abort()
    expect(await g.request('Bash', {}, { signal: controller.signal })).toEqual({ behavior: 'deny' })
    expect(asked).toEqual([])
  })

  test('cancelAll отказывает всем открытым', async () => {
    const { gate: g, resolved } = gate('default')
    const a = g.request('Bash', {}, { toolUseId: 'a' })
    const b = g.request('Edit', {}, { toolUseId: 'b' })
    g.cancelAll()
    expect(await a).toEqual({ behavior: 'deny' })
    expect(await b).toEqual({ behavior: 'deny' })
    expect(resolved.map((r) => r.by)).toEqual(['elsewhere', 'elsewhere'])
    expect(g.pending()).toEqual([])
  })
})
