import { useState } from 'react'
import type { RibbonItem } from '../../../shared/types'
import { Markdown } from '../../markdown/Markdown'
import { AutoTag } from '../AutoTag'

type Permission = Extract<RibbonItem, { kind: 'permission' }>
type Question = Extract<RibbonItem, { kind: 'question' }>
type Plan = Extract<RibbonItem, { kind: 'plan' }>
export type AnsweredCard = Permission | Question | Plan

const SCOPE_LABEL = {
  once: 'Разрешено',
  always: 'Разрешено всё такое',
  session: 'Разрешено до конца сессии'
} as const

function permissionText(item: Permission): string {
  const what = item.target ? `${item.toolName} · ${item.target}` : item.toolName
  switch (item.state) {
    case 'denied':
      return `Запрещено: ${what}${item.reason ? ` — «${item.reason}»` : ''}`
    case 'elsewhere':
      return `Ответили с телефона: ${what}`
    default:
      // No scope means it was allowed once.
      return `${SCOPE_LABEL[item.scope ?? 'once']}: ${what}`
  }
}

function questionText(item: Question): string {
  const names = item.questions.map((q) => q.header || q.question)
  if (item.answers === null) return `Ответили с телефона: ${names.join('; ')}`
  const answers = item.answers
  const parts = item.questions.map((q) => {
    const note = item.notes?.[q.question]
    return `${q.header || q.question} — ${answers[q.question] ?? ''}${note ? ` (${note})` : ''}`
  })
  return `Ответ: ${parts.join('; ')}`
}

function planText(item: Plan): string {
  switch (item.state) {
    case 'approved':
      return item.edited ? 'План принят с правками' : 'План принят'
    case 'rejected':
      return `План отклонён${item.comment ? ` — «${item.comment}»` : ''}`
    case 'elsewhere':
      return 'Ответили с телефона: план'
    default:
      return 'План'
  }
}

/** The one line an answered card is. */
export function summaryText(item: AnsweredCard): string {
  switch (item.kind) {
    case 'permission':
      return permissionText(item)
    case 'question':
      return questionText(item)
    case 'plan':
      return planText(item)
  }
}

/**
 * An answered card, folded to a line. A plan opens on click to the text that
 * was decided on; the others have nothing more to say.
 */
export function CardSummary({ item, tabId }: { item: AnsweredCard; tabId?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const line = (
    <>
      <span className="card-summary-text">{summaryText(item)}</span>
      {item.auto && <AutoTag />}
    </>
  )
  if (item.kind !== 'plan') {
    return (
      <div className="card-summary" data-testid="card-summary" data-kind={item.kind}>
        {line}
      </div>
    )
  }
  return (
    <div className="card-summary is-plan" data-testid="card-summary" data-kind="plan">
      <button
        type="button"
        className="card-summary-line"
        aria-expanded={open}
        title={open ? 'Свернуть план' : 'Показать план'}
        onClick={() => setOpen((v) => !v)}
      >
        {line}
      </button>
      {open && (
        <div className="card-summary-plan" data-testid="card-summary-plan">
          <Markdown text={item.text} {...(tabId ? { tabId } : {})} />
        </div>
      )}
    </div>
  )
}
