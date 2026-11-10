import { useState } from 'react'
import { Check } from 'lucide-react'
import type { RibbonItem } from '../../shared/types'

type Question = Extract<RibbonItem, { kind: 'question' }>

interface Props {
  item: Question
  onAnswer: (toolUseId: string, answers: Record<string, string>) => void
}

/** Several choices of one multi-select question are sent as one text. */
const JOINER = ', '

/**
 * The agent asked something with options — one to four questions at once.
 *
 * Not a permission: there is no «allow» here, there is a choice (spec 6.2).
 * A lone single-choice question is answered by the click itself. Anything
 * else is marked first and sent with «Ответить», once every question has an
 * answer: the agent gets all of them in one go, never only the first.
 */
export function QuestionCard({ item, onAnswer }: Props): JSX.Element {
  const [picked, setPicked] = useState<string[][]>(() => item.questions.map(() => []))
  const answered = item.answers !== null
  const instant = item.questions.length === 1 && !item.questions[0]!.multiSelect

  const send = (labels: string[][]): void => {
    const answers: Record<string, string> = {}
    item.questions.forEach((q, i) => {
      // Option order, not click order: the same picks always read the same.
      const chosen = q.options.map((o) => o.label).filter((label) => labels[i]!.includes(label))
      answers[q.question] = chosen.join(JOINER)
    })
    onAnswer(item.toolUseId, answers)
  }

  const choose = (index: number, label: string): void => {
    if (answered) return
    if (instant) {
      send([[label]])
      return
    }
    setPicked((current) =>
      current.map((labels, i) => {
        if (i !== index) return labels
        if (!item.questions[i]!.multiSelect) return [label]
        return labels.includes(label) ? labels.filter((l) => l !== label) : [...labels, label]
      })
    )
  }

  const isChosen = (index: number, label: string): boolean => {
    if (answered) {
      const given = item.answers![item.questions[index]!.question] ?? ''
      return given === label || given.split(JOINER).includes(label)
    }
    return picked[index]!.includes(label)
  }

  const complete = picked.every((labels) => labels.length > 0)

  return (
    <div className="row-question" data-testid="question-card">
      {item.questions.map((q, index) => (
        <div className="row-question-block" key={q.question}>
          <div className="row-question-text">{q.question}</div>
          <div className="row-question-options">
            {q.options.map((option) => {
              const chosen = isChosen(index, option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  data-testid="question-option"
                  title={option.label}
                  className={chosen ? 'is-chosen' : ''}
                  aria-pressed={chosen}
                  disabled={answered}
                  onClick={() => choose(index, option.label)}
                >
                  <span className="row-question-label">
                    {chosen && <Check size={12} aria-hidden="true" />}
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="row-question-desc">{option.description}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {!instant && !answered && (
        <button
          type="button"
          className="row-question-submit"
          data-testid="question-submit"
          title="Отправить ответ агенту"
          disabled={!complete}
          onClick={() => send(picked)}
        >
          Ответить
        </button>
      )}
    </div>
  )
}
