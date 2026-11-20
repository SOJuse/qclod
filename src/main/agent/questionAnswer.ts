import { versionAtLeast } from './outbox'

/**
 * How a comment on a chosen option reaches the agent: in
 * `annotations[question].notes`, beside the answer, or written into the answer
 * itself as «Вариант — комментарий».
 */
export type NotesMode = 'annotations' | 'inline'

/**
 * How a plan the user edited or commented on reaches the agent: as
 * ExitPlanMode's own `updatedInput.plan`, or — a CLI not known to carry that
 * out — by sending the plan back: ExitPlanMode is refused with the edit and
 * the comment, and the agent proposes it again. Never as a message after an
 * approval: the agent would start on the old plan before reading it.
 */
export type PlanEditMode = 'updatedInput' | 'sendBack'

/**
 * The first CLI known to hand `annotations[question].notes` to the model
 * (probe 05b, step 1). An older or unknown one gets the inline form, which
 * every CLI passes on as it is (step 2).
 */
export const NOTES_ANNOTATIONS_SINCE = '2.1.317'

/**
 * The first CLI known to carry out `updatedInput.plan` — «Approved Plan
 * (edited by user)» (probe 05b, step 3). An older or unknown one gets the plan
 * sent back instead (ruling S2-R8).
 */
export const PLAN_EDIT_SINCE = '2.1.317'

/** The plan as approved, with the user's comment under it. */
export function planWithComment(plan: string, comment?: string): string {
  return comment ? `${plan}\n\nКомментарий пользователя: ${comment}` : plan
}

/**
 * The refusal that sends a plan back for rework: the user's edit, their
 * comment, or both, and a plain word not to start on the old one.
 */
export function planSendBackText(edited?: string, comment?: string): string {
  if (edited !== undefined) {
    return planWithComment(
      `Пользователь поправил план. Не начинай работу — предложи этот вариант снова через ExitPlanMode:\n${edited}`,
      comment
    )
  }
  return (
    'Пользователь одобрит план с учётом комментария. Не начинай работу — учти комментарий и предложи ' +
    `план снова через ExitPlanMode.\n\nКомментарий: ${comment ?? ''}`
  )
}

function atLeast(version: string | null | undefined, least: string): boolean {
  return typeof version === 'string' && versionAtLeast(version, least.split('.').map(Number))
}

/** By `claude_code_version` from system/init; null — not introduced yet. */
export function notesModeFor(version: string | null | undefined): NotesMode {
  return atLeast(version, NOTES_ANNOTATIONS_SINCE) ? 'annotations' : 'inline'
}

/** By `claude_code_version` from system/init; null — not introduced yet. */
export function planEditModeFor(version: string | null | undefined): PlanEditMode {
  return atLeast(version, PLAN_EDIT_SINCE) ? 'updatedInput' : 'sendBack'
}

/**
 * What the agent reads when the user denies a tool. A bare reason was not
 * enough: in probe 05b the model read it as a remark and did the same thing
 * through another tool, so the refusal says outright not to.
 */
export function denialText(reason?: string): string {
  const because = reason ? ` Причина: ${reason}${/[.!?…]$/.test(reason) ? '' : '.'}` : ''
  return (
    `Пользователь запретил этот вызов.${because} ` +
    'Не выполняй это действие другим способом и не обходи запрет — спроси пользователя, если нужно.'
  )
}

/** An answer with its comment, as a CLI without annotations gets it. */
export function inlineAnswer(label: string, note: string): string {
  return `${label} — ${note}`
}

/** One asked question: its text and the labels of its options. */
export interface AskedQuestion {
  question: string
  labels: string[]
}

/** Several choices of one question come as one text (QuestionCard's joiner). */
const JOINER = ', '

/** The questions of an AskUserQuestion input, with their option labels. */
export function askedQuestions(input: Record<string, unknown>): AskedQuestion[] {
  const questions = input['questions']
  if (!Array.isArray(questions)) return []
  return questions.flatMap((q: unknown) => {
    if (typeof q !== 'object' || q === null) return []
    const { question, options } = q as Record<string, unknown>
    if (typeof question !== 'string') return []
    const labels = Array.isArray(options)
      ? options.flatMap((o: unknown) => {
          const label = typeof o === 'object' && o !== null ? (o as Record<string, unknown>)['label'] : undefined
          return typeof label === 'string' ? [label] : []
        })
      : []
    return [{ question, labels }]
  })
}

/** The answer is one option, or several joined by «, » — not the user's own text. */
function isChoice(answer: string, labels: string[]): boolean {
  if (answer === '') return false
  if (labels.includes(answer)) return true
  return answer.split(JOINER).every((part) => labels.includes(part))
}

/**
 * The comments that belong to an answer: on a question that was asked, with a
 * chosen option (one or several). An answer in the user's own words is the
 * comment itself, so a note beside it is dropped; so is an empty one.
 */
export function notesForChoices(
  questions: AskedQuestion[],
  answers: Record<string, string>,
  notes: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { question, labels } of questions) {
    const note = notes[question]
    const answer = answers[question]
    if (!note || answer === undefined || !isChoice(answer, labels)) continue
    out[question] = note
  }
  return out
}

/** The answers as the agent should get them: each comment where `mode` puts it. */
export function encodeAnswers(
  answers: Record<string, string>,
  notes: Record<string, string>,
  mode: NotesMode
): { answers: Record<string, string>; annotations?: Record<string, { notes: string }> } {
  if (Object.keys(notes).length === 0) return { answers }
  if (mode === 'annotations') {
    return {
      answers,
      annotations: Object.fromEntries(Object.entries(notes).map(([q, note]) => [q, { notes: note }]))
    }
  }
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([q, answer]) => [q, notes[q] ? inlineAnswer(answer, notes[q]) : answer])
    )
  }
}

/**
 * AskUserQuestion's `updatedInput`: the call's own input, with the answers
 * and, by `mode`, the comments on the chosen options.
 */
export function encodeQuestionAnswer(
  input: Record<string, unknown>,
  answers: Record<string, string>,
  notes: Record<string, string>,
  mode: NotesMode
): Record<string, unknown> {
  const encoded = encodeAnswers(answers, notesForChoices(askedQuestions(input), answers, notes), mode)
  return { ...input, ...encoded }
}
