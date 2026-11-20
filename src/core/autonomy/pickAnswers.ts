import type { AskedQuestion } from './types'

/** The suffix the agent marks its own advice with; the answer key keeps it (decision 5). */
export const RECOMMENDED = /\s*\((Recommended|Рекомендуется)\)\s*$/i

export function isRecommended(label: string): boolean {
  return RECOMMENDED.test(label)
}

/** Without the suffix — what the card and the label show. */
export function shownLabel(label: string): string {
  return label.replace(RECOMMENDED, '')
}

/**
 * The labels Qclod picks for one question: the first recommended one, or the
 * first option; in a multiple choice every recommended one, or the first.
 * Empty when the question has no options at all.
 */
export function pickedLabels(question: AskedQuestion): string[] {
  const recommended = question.options.filter(isRecommended)
  if (question.multiSelect) return recommended.length > 0 ? recommended : question.options.slice(0, 1)
  return [recommended[0] ?? question.options[0]].filter((label): label is string => label !== undefined)
}

/**
 * One question: first recommended, else first. multiSelect: every recommended
 * joined by ", ", else first. Labels as they came — the CLI matches the answer
 * against the option's exact label. A question with no options is left out.
 */
export function pickAnswers(questions: AskedQuestion[]): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const labels = pickedLabels(question)
    if (labels.length > 0) answers[question.question] = labels.join(', ')
  }
  return answers
}
