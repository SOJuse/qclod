import type { RibbonItem } from '../../shared/types'

type Question = Extract<RibbonItem, { kind: 'question' }>

interface Props {
  item: Question
  onAnswer: (toolUseId: string, choice: string) => void
}

/**
 * The agent asked something with options.
 *
 * Not a permission: there is no «allow» here, there is a choice (spec 6.2).
 * The chosen option goes back as an ordinary message, so the answer reads in
 * the ribbon exactly as if the user had typed it.
 */
export function QuestionCard({ item, onAnswer }: Props): JSX.Element {
  return (
    <div className="row-question" data-testid="question-card">
      <div className="row-question-text">{item.question}</div>
      <div className="row-question-options">
        {item.options.map((option) => (
          <button
            key={option}
            type="button"
            data-testid="question-option"
            className={item.answer === option ? 'is-chosen' : ''}
            disabled={item.answer !== null}
            onClick={() => onAnswer(item.toolUseId, option)}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  )
}
