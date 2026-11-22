import { describe, expect, test } from 'vitest'
import { Outbox, queueModeFrom } from '../../src/main/agent/outbox'

describe('queueModeFrom', () => {
  test("queueModeFrom({claude_code_version:'2.1.317'}) === 'cli'", () => {
    expect(queueModeFrom({ claude_code_version: '2.1.317' })).toBe('cli')
  })

  test("'2.1.200' даёт 'local'", () => {
    expect(queueModeFrom({ claude_code_version: '2.1.200' })).toBe('local')
  })

  test("{capabilities:['interrupt_receipt_v1']} без версии даёт 'cli'", () => {
    expect(queueModeFrom({ capabilities: ['interrupt_receipt_v1'] })).toBe('cli')
  })

  test('граница версии и мусор вместо версии', () => {
    expect(queueModeFrom({ claude_code_version: '2.1.259' })).toBe('cli')
    expect(queueModeFrom({ claude_code_version: '2.1.258' })).toBe('local')
    expect(queueModeFrom({ claude_code_version: '3.0.0' })).toBe('cli')
    expect(queueModeFrom({ claude_code_version: '2.10.0' })).toBe('cli')
    expect(queueModeFrom({ claude_code_version: 'дев' })).toBe('local')
    expect(queueModeFrom({ claude_code_version: 2317 })).toBe('local')
    expect(queueModeFrom({ capabilities: 'interrupt_receipt_v1' })).toBe('local')
    expect(queueModeFrom({})).toBe('local')
  })
})

describe('Outbox', () => {
  const input = (text: string, files = 0) => ({
    text,
    attachments: Array.from({ length: files }, (_, i) => ({ kind: 'file' as const, path: `C:/f${i}.ts` }))
  })

  test('view() отдаёт записи по порядку с их state и canSendNow', () => {
    const outbox = new Outbox()
    outbox.add({ uuid: 'u1', input: input('раз'), composed: 'раз', state: 'waiting' })
    outbox.add({ uuid: 'u2', input: input('два', 2), composed: 'два', state: 'sending' })
    outbox.add({ uuid: 'u3', input: input('три'), composed: 'три', state: 'sending' })
    outbox.mark('u3', 'queued')

    expect(outbox.view(true)).toEqual([
      { id: 'u1', text: 'раз', attachments: 0, state: 'waiting', canSendNow: false },
      { id: 'u2', text: 'два', attachments: 2, state: 'sending', canSendNow: true },
      { id: 'u3', text: 'три', attachments: 0, state: 'queued', canSendNow: true }
    ])
    expect(outbox.view(false).map((q) => q.canSendNow)).toEqual([false, false, false])

    // Already being cancelled: nothing to send now.
    outbox.mark('u2', 'cancelling')
    expect(outbox.view(true)[1]).toMatchObject({ state: 'cancelling', canSendNow: false })
  })

  test('get, remove и pending', () => {
    const outbox = new Outbox()
    outbox.add({ uuid: 'u1', input: input('раз'), composed: 'раз', state: 'sending' })
    outbox.add({ uuid: 'u2', input: input('два'), composed: 'два', state: 'sending' })

    expect(outbox.get('u1')).toMatchObject({ uuid: 'u1', requestedCancel: false })
    expect(outbox.get('нет')).toBeUndefined()
    expect(outbox.remove('u1')?.input.text).toBe('раз')
    expect(outbox.remove('u1')).toBeUndefined()
    expect(outbox.pending().map((e) => e.uuid)).toEqual(['u2'])
    // A mark on what is gone changes nothing.
    outbox.mark('u1', 'queued')
    expect(outbox.size).toBe(1)
  })
})
