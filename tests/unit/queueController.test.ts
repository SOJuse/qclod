import { describe, expect, test, vi } from 'vitest'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { QueueController, type QueueHost } from '../../src/main/agent/queueController'
import type { AgentDriver } from '../../src/main/agent/driver'

/** A host that only records: a turn runs while `running` says so. */
function stubHost(): {
  host: { [K in keyof QueueHost]: ReturnType<typeof vi.fn> & QueueHost[K] }
  state: { running: boolean; turn: number }
  driver: ReturnType<typeof createFakeSdk>
} {
  const driver = createFakeSdk({ steps: [], nextTurn: [] })
  const state = { running: true, turn: 1 }
  const host = {
    driver: vi.fn(() => driver as unknown as AgentDriver),
    turnRunning: vi.fn(() => state.running),
    startTurn: vi.fn(() => {
      state.turn += 1
      state.running = true
    }),
    endTurn: vi.fn(() => {
      state.running = false
    }),
    currentTurn: vi.fn(() => state.turn),
    showUser: vi.fn(),
    remember: vi.fn(),
    emitQueue: vi.fn(),
    notice: vi.fn(),
    cancelWaits: vi.fn(),
    relayCancelled: vi.fn()
  }
  return { host: host as never, state, driver }
}

/** A CLI that keeps its own queue, with one message of the user's on the strip. */
function withOneQueued(): ReturnType<typeof stubHost> & { queue: QueueController; uuid: string } {
  const stub = stubHost()
  const queue = new QueueController(stub.host)
  queue.onInit({ type: 'system', subtype: 'init', capabilities: ['interrupt_receipt_v1'] })
  queue.submit({ text: 'два', attachments: [] })
  const uuid = queue.view()[0]!.id
  for (const fn of Object.values(stub.host)) fn.mockClear()
  return { ...stub, queue, uuid }
}

describe('QueueController', () => {
  test('started у записи плашки показывает пузырь через host.showUser и начинает ход, если хода не было', () => {
    const { queue, host, state, uuid } = withOneQueued()
    // The turn that was running when it was queued has ended.
    state.running = false

    queue.onLifecycle({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })

    expect(host.showUser).toHaveBeenCalledTimes(1)
    expect(host.showUser).toHaveBeenCalledWith({ text: 'два', attachments: [] }, 'два', uuid, {})
    expect(host.startTurn).toHaveBeenCalled()
    expect(queue.size).toBe(0)
  })

  test('onResult с queued_turn_count 1 даёт hold, с 0 и пустой плашкой — release', () => {
    const { host } = stubHost()
    const queue = new QueueController(host)
    queue.onInit({ type: 'system', subtype: 'init', capabilities: ['interrupt_receipt_v1'] })

    expect(queue.onResult({ type: 'result', queued_turn_count: 1 })).toBe('hold')
    expect(queue.onResult({ type: 'result', queued_turn_count: 0 })).toBe('release')
  })

  test('cancelled с чужим uuid ничего не вызывает у host', () => {
    const { queue, host } = withOneQueued()

    queue.onLifecycle({ type: 'command_lifecycle', command_uuid: 'чужой', state: 'cancelled' })

    for (const fn of Object.values(host)) expect(fn).not.toHaveBeenCalled()
    expect(queue.size).toBe(1)
  })

  test('cancelled без requestedCancel — notice «Сообщение не дошло до агента: ход прервали — «<текст>»», tone error', () => {
    const { queue, host, uuid } = withOneQueued()

    queue.onLifecycle({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' })

    expect(host.notice).toHaveBeenCalledTimes(1)
    expect(host.notice).toHaveBeenCalledWith('Сообщение не дошло до агента: ход прервали — «два»', 'error')
    expect(queue.size).toBe(0)
  })
})

describe('QueueController: этап 4 — поручение сабагенту', () => {
  const relay = { relayId: 'rel-1', cardId: 'r5', agent: 'Explore', text: 'проверь тесты' }
  const instruction = { text: 'Передай агенту a1 …\n\nпроверь тесты', attachments: [] }

  function withRelayQueued(): ReturnType<typeof stubHost> & { queue: QueueController; uuid: string } {
    const stub = stubHost()
    const queue = new QueueController(stub.host)
    queue.onInit({ type: 'system', subtype: 'init', capabilities: ['interrupt_receipt_v1'] })
    queue.submit(instruction, { priority: 'next', relay })
    const uuid = queue.view()[0]!.id
    for (const fn of Object.values(stub.host)) fn.mockClear()
    return { ...stub, queue, uuid }
  }

  test('в плашке — «→ агенту …» с relay; прочитанное показывается с relay', () => {
    const { queue, host, uuid } = withRelayQueued()
    expect(queue.view()[0]).toMatchObject({ text: '→ агенту Explore: проверь тесты', relay: true })
    queue.onLifecycle({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
    expect(host.showUser).toHaveBeenCalledWith(instruction, instruction.text, null, { relay })
  })

  test('снятое CLI без спроса — relayCancelled и notice с текстом человека', () => {
    const { queue, host, uuid } = withRelayQueued()
    queue.onLifecycle({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' })
    expect(host.relayCancelled).toHaveBeenCalledWith(relay)
    expect(host.notice).toHaveBeenCalledWith('Сообщение не дошло до агента: ход прервали — «проверь тесты»', 'error')
  })

  test('take отдаёт поручение с relay, requeue у преемника его сохраняет', () => {
    const { queue } = withRelayQueued()
    const taken = queue.take()
    expect(taken).toEqual([{ ...instruction, relay }])

    const next = stubHost()
    const successor = new QueueController(next.host)
    successor.onInit({ type: 'system', subtype: 'init', capabilities: ['interrupt_receipt_v1'] })
    successor.requeue(taken)
    expect(successor.view()[0]).toMatchObject({ text: '→ агенту Explore: проверь тесты', relay: true })
    // The driver gets the instruction, not the relay record.
    expect(next.driver.sent.at(-1)).toEqual(instruction)
  })
})
