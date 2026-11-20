import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CardSummary, summaryText } from '../../src/renderer/components/cards/CardSummary'
import type { AnsweredCard } from '../../src/renderer/components/cards/CardSummary'
import type { RibbonItem } from '../../src/shared/types'

type Perm = Extract<RibbonItem, { kind: 'permission' }>
const perm = (extra: Partial<Perm>): Perm => ({
  id: 'p',
  kind: 'permission',
  requestId: 'r',
  toolName: 'Bash',
  target: 'npm test',
  state: 'allowed',
  ...extra
})
type Q = Extract<RibbonItem, { kind: 'question' }>
type P = Extract<RibbonItem, { kind: 'plan' }>
const question = (extra: Partial<Q>): Q => ({
  id: 'q',
  kind: 'question',
  toolUseId: 'tu',
  questions: [
    { question: 'Какую базу взять?', header: 'База', options: [], multiSelect: false },
    { question: 'Когда?', header: '', options: [], multiSelect: false }
  ],
  answers: { 'Какую базу взять?': 'Postgres', 'Когда?': 'сегодня' },
  ...extra
})
const plan = (extra: Partial<P>): P => ({
  id: 'l',
  kind: 'plan',
  requestId: 'r',
  text: '1. шаг',
  state: 'approved',
  ...extra
})

describe('CardSummary: текст строки', () => {
  it('разрешение', () => {
    expect(summaryText(perm({ scope: 'once' }))).toBe('Разрешено: Bash · npm test')
    expect(summaryText(perm({ scope: 'always' }))).toBe('Разрешено всё такое: Bash · npm test')
    expect(summaryText(perm({ scope: 'session' }))).toBe('Разрешено до конца сессии: Bash · npm test')
  })
  it('разрешение без scope — как once (П6)', () => {
    expect(summaryText(perm({}))).toBe('Разрешено: Bash · npm test')
  })
  it('запрет с причиной и без', () => {
    expect(summaryText(perm({ state: 'denied', reason: 'не сейчас' }))).toBe('Запрещено: Bash · npm test — «не сейчас»')
    expect(summaryText(perm({ state: 'denied' }))).toBe('Запрещено: Bash · npm test')
  })
  it('ответили с телефона', () => {
    expect(summaryText(perm({ state: 'elsewhere' }))).toBe('Ответили с телефона: Bash · npm test')
  })
  it('вопрос: заголовок или вопрос, заметка в скобках, через «; »', () => {
    expect(summaryText(question({ notes: { 'Какую базу взять?': 'для отчётов' } }))).toBe(
      'Ответ: База — Postgres (для отчётов); Когда? — сегодня'
    )
  })
  it('план', () => {
    expect(summaryText(plan({}))).toBe('План принят')
    expect(summaryText(plan({ edited: true }))).toBe('План принят с правками')
    expect(summaryText(plan({ state: 'rejected', comment: 'слишком широко' }))).toBe('План отклонён — «слишком широко»')
  })
  it('план, одобренный с правкой или комментарием на старом CLI, — отправлен на доработку, не отклонён (S2-R8)', () => {
    expect(summaryText(plan({ state: 'rejected', sentBack: true, comment: 'и тесты' }))).toBe(
      'План отправлен на доработку — «и тесты»'
    )
    expect(summaryText(plan({ state: 'rejected', sentBack: true, edited: true }))).toBe(
      'План с правками отправлен на доработку'
    )
    expect(summaryText(plan({ state: 'rejected', sentBack: true, edited: true, comment: 'коротко' }))).toBe(
      'План с правками отправлен на доработку — «коротко»'
    )
  })
})

describe('CardSummary: разметка', () => {
  const html = (item: AnsweredCard): string => renderToStaticMarkup(createElement(CardSummary, { item, tabId: 't' }))
  it('testid и data-kind', () => {
    const out = html(perm({}))
    expect(out).toContain('data-testid="card-summary"')
    expect(out).toContain('data-kind="permission"')
  })
  it('auto — одна метка «авто» с title', () => {
    const out = html(perm({ auto: true }))
    expect(out.match(/data-testid="auto-tag"/g)).toHaveLength(1)
    expect(out).toContain('title="Ответил Qclod сам"')
    expect(out).toContain('>авто<')
    expect(html(perm({}))).not.toContain('auto-tag')
  })
})
