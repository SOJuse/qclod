import { describe, expect, it } from 'vitest'
import { PINNED_KINDS, cardIdOf, isOpenCard, isStaleQuestion, openCards } from '../../src/renderer/chat/openCards'
import type { RibbonItem } from '../../src/shared/types'

const perm = (id: string, extra: Partial<Extract<RibbonItem, { kind: 'permission' }>> = {}): RibbonItem => ({
  id,
  kind: 'permission',
  requestId: `req-${id}`,
  toolName: 'Bash',
  target: 'ls',
  state: 'pending',
  ...extra
})
const question = (id: string, extra: Partial<Extract<RibbonItem, { kind: 'question' }>> = {}): RibbonItem => ({
  id,
  kind: 'question',
  toolUseId: `tu-${id}`,
  questions: [],
  answers: null,
  ...extra
})
const plan = (id: string, state: 'pending' | 'approved' = 'pending'): RibbonItem => ({
  id,
  kind: 'plan',
  requestId: `tu-${id}`,
  text: 'шаги',
  state
})
const user = (id: string): RibbonItem => ({ id, kind: 'user', text: 'привет', attachments: [] })
const agent = (id: string): RibbonItem => ({
  id,
  kind: 'subagent',
  toolUseId: `tu-${id}`,
  name: 'Explore',
  task: 't',
  state: 'running',
  summary: ''
})

describe('openCards', () => {
  it('разрешение сабагента попадает с from: Explore', () => {
    const items = [agent('a'), perm('p', { parentId: 'a' })]
    const cards = openCards(items, 'tab1')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: 'permission', tabId: 'tab1', requestId: 'req-p', fromAgent: 'Explore' })
  })

  it('вопрос, после которого есть user, не открыт', () => {
    const items = [question('q'), user('u')]
    expect(openCards(items, 't')).toEqual([])
    expect(isOpenCard(items[0]!, items)).toBe(false)
    expect(isStaleQuestion(items[0]!, items)).toBe(true)
  })

  it('отвеченные и «ответили с телефона» не открыты', () => {
    const items = [
      perm('a', { state: 'allowed' }),
      plan('b', 'approved'),
      question('c', { answers: { Q: 'да' } }),
      question('d', { elsewhere: true })
    ]
    expect(openCards(items, 't')).toEqual([])
    expect(isStaleQuestion(items[3]!, items)).toBe(false)
  })

  it('порядок — порядок ленты', () => {
    const items = [question('q'), perm('p'), plan('l')]
    expect(openCards(items, 't').map((c) => c.kind)).toEqual(['question', 'permission', 'plan'])
  })

  it('cardIdOf: вопрос — toolUseId, план и разрешение — requestId', () => {
    const [q, p, l] = openCards([question('q'), perm('p'), plan('l')], 't')
    expect(cardIdOf(q!)).toBe('tu-q')
    expect(cardIdOf(p!)).toBe('req-p')
    expect(cardIdOf(l!)).toBe('tu-l')
  })

  it('пока карточки не в закреплённой плашке, из ленты не уходят (П2)', () => {
    expect(PINNED_KINDS.size).toBe(0)
  })
})
