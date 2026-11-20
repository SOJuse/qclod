import type { QuestionView } from '../../shared/types'

/**
 * Where a question card is: which question it shows, and for every question
 * what is chosen and what is written in its field. Kept for all of them, so
 * «Назад» finds the earlier answers as they were.
 */
export interface StepState {
  step: number
  picks: string[][]
  texts: string[]
}

/** Several choices of one question go as one text (main's questionAnswer.ts splits on it). */
const JOINER = ', '

/** The label suffix the agent marks its advice with; shown as a badge, never as text. */
export const RECOMMENDED = /\s*\(Recommended\)\s*$/i

export function initialSteps(questions: QuestionView[]): StepState {
  return { step: 0, picks: questions.map(() => []), texts: questions.map(() => '') }
}

/**
 * A press on an option of the current question. A single-choice question takes
 * the new one instead of the old, and the same one again clears it — so a
 * chance press never shuts out an answer in one's own words. A multi-choice
 * one toggles it.
 */
export function pick(state: StepState, q: QuestionView, label: string): StepState {
  const current = state.picks[state.step] ?? []
  let next: string[]
  if (current.includes(label)) next = current.filter((l) => l !== label)
  else next = q.multiSelect ? [...current, label] : [label]
  return { ...state, picks: state.picks.map((labels, i) => (i === state.step ? next : labels)) }
}

/** What is written in the current question's field. */
export function setText(state: StepState, text: string): StepState {
  return { ...state, texts: state.texts.map((t, i) => (i === state.step ? text : t)) }
}

export function goTo(state: StepState, step: number): StepState {
  return { ...state, step }
}

/** The current question has an answer: something chosen, or something written. */
export function canAdvance(state: StepState): boolean {
  return (state.picks[state.step]?.length ?? 0) > 0 || (state.texts[state.step] ?? '').trim() !== ''
}

/**
 * Every answer at once. With something chosen the answer is the labels as they
 * came — suffix and all — in the options' order, not the order pressed, and the
 * text is a comment on them; with nothing chosen the text is the answer.
 */
export function collect(
  questions: QuestionView[],
  state: StepState
): { answers: Record<string, string>; notes: Record<string, string> } {
  const answers: Record<string, string> = {}
  const notes: Record<string, string> = {}
  questions.forEach((q, i) => {
    const picked = state.picks[i] ?? []
    const text = (state.texts[i] ?? '').trim()
    const chosen = q.options.map((o) => o.label).filter((label) => picked.includes(label))
    if (chosen.length > 0) {
      answers[q.question] = chosen.join(JOINER)
      if (text) notes[q.question] = text
    } else {
      answers[q.question] = text
    }
  })
  return { answers, notes }
}

export function displayLabel(label: string): { text: string; recommended: boolean } {
  const recommended = RECOMMENDED.test(label)
  return { text: recommended ? label.replace(RECOMMENDED, '') : label, recommended }
}
