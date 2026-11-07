import { describe, expect, test, vi } from 'vitest'
import { PermissionBroker } from '../../src/main/agent/permissions'
import type { PermissionRule } from '../../src/main/agent/permissionStore'
import type { PermissionRequest } from '../../src/shared/types'

function makeBroker(rules: PermissionRule[] = []): {
  broker: PermissionBroker
  asked: PermissionRequest[]
  saved: PermissionRule[][]
} {
  const asked: PermissionRequest[] = []
  const saved: PermissionRule[][] = []
  let current = [...rules]

  const broker = new PermissionBroker({
    loadRules: () => current,
    saveRules: (next) => {
      current = next
      saved.push(next)
    },
    ask: (request) => asked.push(request)
  })
  return { broker, asked, saved }
}

describe('PermissionBroker', () => {
  test('запрос без правила уходит человеку и ждёт ответа', async () => {
    const { broker, asked } = makeBroker()

    const pending = broker.request('tab-1', 'Bash', { command: 'npm test' })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ tabId: 'tab-1', toolName: 'Bash', target: 'npm test' })

    // Nothing is decided until the person answers.
    const notYet = await Promise.race([pending, Promise.resolve('ещё ждёт')])
    expect(notYet).toBe('ещё ждёт')

    broker.answer(asked[0]!.requestId, { behavior: 'allow' })
    await expect(pending).resolves.toEqual({ behavior: 'allow' })
  })

  test('запрос с правилом отвечает сам и человека не беспокоит', async () => {
    const { broker, asked } = makeBroker([{ id: 'r1', toolName: 'Read', behavior: 'allow' }])

    await expect(broker.request('tab-1', 'Read', { file_path: 'a.ts' })).resolves.toEqual({
      behavior: 'allow'
    })
    expect(asked).toHaveLength(0)
  })

  test('правило-запрет отклоняет без вопроса', async () => {
    const { broker, asked } = makeBroker([{ id: 'r1', toolName: 'Bash', behavior: 'deny' }])

    await expect(broker.request('tab-1', 'Bash', { command: 'rm -rf /' })).resolves.toEqual({
      behavior: 'deny'
    })
    expect(asked).toHaveLength(0)
  })

  test('remember добавляет правило', async () => {
    const { broker, asked, saved } = makeBroker()

    const pending = broker.request('tab-1', 'Edit', { file_path: 'C:/проект/auth.ts' })
    broker.answer(asked[0]!.requestId, { behavior: 'allow', remember: true })
    await pending

    expect(saved).toHaveLength(1)
    expect(saved[0]![0]).toMatchObject({ toolName: 'Edit', behavior: 'allow' })

    // And the next identical request is answered without asking again.
    await expect(broker.request('tab-1', 'Edit', { file_path: 'C:/проект/auth.ts' })).resolves.toEqual({
      behavior: 'allow'
    })
    expect(asked).toHaveLength(1)
  })

  test('без remember правило не появляется', async () => {
    const { broker, asked, saved } = makeBroker()

    const pending = broker.request('tab-1', 'Edit', { file_path: 'a.ts' })
    broker.answer(asked[0]!.requestId, { behavior: 'allow' })
    await pending

    expect(saved).toEqual([])
  })

  test('закрытие вкладки отклоняет её висящие запросы, а не держит их вечно', async () => {
    const { broker, asked } = makeBroker()

    const mine = broker.request('tab-1', 'Bash', { command: 'npm test' })
    const other = broker.request('tab-2', 'Bash', { command: 'npm build' })
    expect(asked).toHaveLength(2)

    broker.cancelTab('tab-1')

    await expect(mine).resolves.toEqual({ behavior: 'deny' })
    const stillWaiting = await Promise.race([other, Promise.resolve('ещё ждёт')])
    expect(stillWaiting).toBe('ещё ждёт')

    broker.answer(asked[1]!.requestId, { behavior: 'allow' })
    await expect(other).resolves.toEqual({ behavior: 'allow' })
  })

  test('ответ на неизвестный запрос игнорируется', () => {
    const { broker } = makeBroker()
    expect(() => broker.answer('нет-такого', { behavior: 'allow' })).not.toThrow()
  })

  test('повторный ответ на тот же запрос игнорируется', async () => {
    const { broker, asked } = makeBroker()

    const pending = broker.request('tab-1', 'Bash', { command: 'npm test' })
    broker.answer(asked[0]!.requestId, { behavior: 'allow' })
    broker.answer(asked[0]!.requestId, { behavior: 'deny' })

    await expect(pending).resolves.toEqual({ behavior: 'allow' })
  })

  test('список правил виден и правило удаляется', async () => {
    const { broker, asked } = makeBroker()

    const pending = broker.request('tab-1', 'Read', { file_path: 'a.ts' })
    broker.answer(asked[0]!.requestId, { behavior: 'allow', remember: true })
    await pending

    const rules = broker.rules()
    expect(rules).toHaveLength(1)

    broker.deleteRule(rules[0]!.id)
    expect(broker.rules()).toEqual([])
  })

  test('правила перечитываются на каждый запрос', async () => {
    const loadRules = vi.fn(() => [] as PermissionRule[])
    const broker = new PermissionBroker({
      loadRules,
      saveRules: () => undefined,
      ask: () => undefined
    })

    void broker.request('tab-1', 'Read', {})
    void broker.request('tab-1', 'Read', {})

    expect(loadRules).toHaveBeenCalledTimes(2)
  })
})
