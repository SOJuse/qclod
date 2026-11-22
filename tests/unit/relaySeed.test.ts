import { describe, expect, test } from 'vitest'
import { seedFromRelay } from '../../src/main/ssh/relaySeed'
import type { JournalRecord } from '../../src/shared/relayProtocol'
import type { RibbonItem } from '../../src/shared/types'

const at = 1_700_000_000_000
const sent = (q: number, text: string, by: 'client' | 'autonomy', uuid?: string): JournalRecord => ({
  q,
  at,
  k: 'sent',
  d: { input: { text, attachments: [] }, by, ...(uuid ? { opts: { uuid } } : {}) }
})
const sdk = (q: number, d: unknown): JournalRecord => ({ q, at, k: 'sdk', d })
const assistant = (id: string, content: unknown[]) => ({ type: 'assistant', message: { id, role: 'assistant', content } })

describe('seedFromRelay', () => {
  test('журнал из sent/sdk даёт пузырь и ответ; открытый инструмент остаётся running', () => {
    const seed = seedFromRelay([
      sent(1, 'собери проект', 'client', 'u1'),
      sdk(2, assistant('m1', [{ type: 'text', text: 'Собираю.' }])),
      sdk(3, assistant('m2', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm run build' } }]))
    ])
    const items = seed.builder.items
    const users = items.filter((i) => i.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ text: 'собери проект' })
    expect(users[0]).not.toHaveProperty('auto')
    expect(items.some((i) => i.kind === 'agentText' && i.text === 'Собираю.')).toBe(true)
    const tool = items.find((i): i is Extract<RibbonItem, { kind: 'tool' }> => i.kind === 'tool')!
    // The relay's agent still runs it: no finishReplay, nothing marked «не закончил».
    expect(tool.state).toBe('running')
  })

  test('by:autonomy помечен «авто»', () => {
    const seed = seedFromRelay([sent(1, 'продолжай', 'autonomy')])
    expect(seed.builder.items[0]).toMatchObject({ kind: 'user', text: 'продолжай', auto: true })
  })

  test('эхо CLI того же сообщения не даёт второго пузыря', () => {
    const seed = seedFromRelay([
      sent(1, 'привет', 'client', 'u1'),
      sdk(2, { type: 'user', uuid: 'x', message: { role: 'user', content: 'привет' } }),
      sdk(3, assistant('m1', [{ type: 'text', text: 'Здравствуйте' }]))
    ])
    expect(seed.builder.items.filter((i) => i.kind === 'user')).toHaveLength(1)
  })

  test('заметки посредника — строками ленты', () => {
    const seed = seedFromRelay([
      { q: 1, at, k: 'notice', d: { kind: 'text', text: 'Агент перезапущен', tone: 'error' } },
      { q: 2, at, k: 'notice', d: { kind: 'autonomy', notice: { kind: 'limitOver' }, alert: false } }
    ])
    const notices = seed.builder.items.filter((i) => i.kind === 'notice')
    expect(notices).toHaveLength(2)
    expect(notices[0]).toMatchObject({ text: 'Агент перезапущен', tone: 'error' })
  })
})
