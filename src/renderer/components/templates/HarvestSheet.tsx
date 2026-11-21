import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { plural } from '../../../shared/format'
import type {
  HarvestErrorReason,
  HarvestPreview,
  HarvestProject,
  TemplateDraft,
  TemplateProposal
} from '../../../shared/types'
import { useModalFocus } from '../../ui/modalFocus'
import './HarvestSheet.css'

/** Where «Собрать мои шаблоны» is: reading, showing what would go, asking Claude, the answer, or why not. */
export type HarvestState =
  | { step: 'loading' }
  | { step: 'preview'; preview: HarvestPreview }
  | { step: 'running'; preview: HarvestPreview }
  | { step: 'results'; proposals: TemplateProposal[]; costUsd: number | null }
  | { step: 'error'; reason: HarvestErrorReason; detail?: string }

const messages = (n: number): string => `${n} ${plural(n, 'сообщение', 'сообщения', 'сообщений')}`
const fromSessions = (n: number): string => `${n} ${plural(n, 'разговора', 'разговоров', 'разговоров')}`
const inProjects = (n: number): string => `${n} ${plural(n, 'проекте', 'проектах', 'проектах')}`
export const templatesCount = (n: number): string => `${n} ${plural(n, 'шаблон', 'шаблона', 'шаблонов')}`

/** «около 12 тыс.», «около 0,9 тыс.» */
function thousands(chars: number): string {
  const k = chars / 1000
  if (k >= 10) return String(Math.round(k))
  return (Math.max(0.1, Math.round(k * 10) / 10)).toFixed(1).replace(/\.0$/, '').replace('.', ',')
}

function money(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

export function harvestErrorText(reason: HarvestErrorReason, detail?: string): string {
  switch (reason) {
    case 'noAgent':
      return 'Claude Code не найден. Укажите путь в настройках.'
    case 'notLoggedIn':
      return 'Claude Code не вошёл в аккаунт. Войдите и попробуйте снова.'
    case 'limit':
      return 'Лимит подписки исчерпан. Попробуйте после сброса.'
    case 'timeout':
      return 'Claude не ответил за 3 минуты.'
    case 'badAnswer':
      return 'Claude ответил не в том виде. Попробуйте ещё раз.'
    case 'cancelled':
      return 'Остановлено.'
    case 'failed':
      return `Не получилось: ${detail ?? 'неизвестная ошибка'}`
  }
}

interface ViewProps {
  state: HarvestState
  /** Every project of the first look, for its checkbox: one left out stays in the list. */
  projects: HarvestProject[]
  excluded: Set<string>
  showItems: boolean
  /** Indexes of the proposals ticked. */
  checked: Set<number>
  onToggleProject(key: string): void
  onToggleShow(): void
  onRun(): void
  onStop(): void
  onClose(): void
  onToggleProposal(index: number): void
  onSave(): void
  onRetry(): void
  onFocusLost?(): void
}

/** A proposal's text: six lines, then «ещё». */
function ProposalBody({ body }: { body: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = body.split('\n')
  const long = lines.length > 6
  return (
    <>
      <pre className="harvest-proposal-body">{open || !long ? body : lines.slice(0, 6).join('\n')}</pre>
      {long && !open && (
        <button type="button" className="btn btn-sm btn-ghost harvest-more" onClick={() => setOpen(true)}>
          ещё
        </button>
      )}
    </>
  )
}

export function HarvestSheetView(props: ViewProps): JSX.Element {
  const { state, projects, excluded, showItems, checked } = props
  const sheet = useRef<HTMLDivElement | null>(null)
  const trap = useModalFocus(sheet, props.onFocusLost)

  return (
    <div className="sheet-backdrop" onMouseDown={props.onClose}>
      <div
        ref={sheet}
        className="sheet harvest-sheet"
        data-testid="harvest-sheet"
        data-step={state.step}
        role="dialog"
        aria-modal="true"
        aria-label="Собрать мои шаблоны"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            props.onClose()
            return
          }
          trap(e)
        }}
      >
        <header className="sheet-head">
          <h2 className="sheet-title">Собрать мои шаблоны</h2>
          <button type="button" className="btn btn-sm btn-ghost" aria-label="Закрыть" title="Закрыть" onClick={props.onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body harvest-body">{body()}</div>
        {foot()}
      </div>
    </div>
  )

  function body(): JSX.Element {
    switch (state.step) {
      case 'loading':
        return (
          <p className="harvest-note" role="status">
            Смотрю историю Claude Code…
          </p>
        )
      case 'preview':
      case 'running': {
        const p = state.preview
        if (state.step === 'running') {
          return (
            <p className="harvest-note" role="status" data-testid="harvest-running">
              Claude читает ваши сообщения и подбирает шаблоны… Обычно это меньше минуты.
            </p>
          )
        }
        return (
          <>
            {p.prompts === 0 ? (
              <p className="harvest-note" data-testid="harvest-empty">
                В истории нет ваших сообщений — собирать не из чего.
              </p>
            ) : (
              <p className="harvest-summary" data-testid="harvest-summary">
                {`Qclod возьмёт ваши сообщения из истории Claude Code за последние ${p.sinceDays} дней: ${messages(p.prompts)} из ${fromSessions(p.sessions)} в ${inProjects(p.projects.length)}, около ${thousands(p.chars)} тыс. символов.`}
              </p>
            )}
            <p className="harvest-note">
              Возьмутся только сообщения, которые вы писали сами. Ответы Claude, вывод команд и содержимое файлов не читаются.
            </p>
            <p className="harvest-note">
              {`Они уйдут в Claude одним запросом через ваш Claude Code (модель ${p.model}) и займут часть лимита подписки. Сами сообщения Qclod не сохраняет — только шаблоны, которые вы отметите.`}
            </p>
            {p.truncated && <p className="harvest-note">Сообщений больше — возьмутся самые свежие.</p>}
            {projects.length > 0 && (
              <ul className="harvest-projects">
                {projects.map((project) => (
                  <li key={project.key}>
                    <label className="harvest-project">
                      <input
                        type="checkbox"
                        data-testid="harvest-project"
                        data-key={project.key}
                        checked={!excluded.has(project.key)}
                        onChange={() => props.onToggleProject(project.key)}
                      />
                      <span title={project.label}>{`${project.label} — ${project.prompts} сообщ.`}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {p.items.length > 0 && (
              <button type="button" className="btn btn-sm btn-ghost harvest-show" data-testid="harvest-show" onClick={props.onToggleShow}>
                {showItems ? 'Скрыть' : 'Показать, что уйдёт'}
              </button>
            )}
            {showItems && (
              <div className="harvest-items" data-testid="harvest-items" role="document" aria-label="Что уйдёт">
                {p.items.map((item, i) => (
                  <pre key={i} className="harvest-item">
                    {item.text}
                  </pre>
                ))}
              </div>
            )}
          </>
        )
      }
      case 'results':
        if (state.proposals.length === 0) {
          return (
            <p className="harvest-note" data-testid="harvest-none">
              Claude не нашёл повторяющихся просьб — шаблонов не предложено.
            </p>
          )
        }
        return (
          <>
            <p className="harvest-summary">{`Claude предлагает ${templatesCount(state.proposals.length)}. Отметьте нужные.`}</p>
            <ul className="harvest-proposals">
              {state.proposals.map((proposal, i) => (
                <li key={i} className={`harvest-proposal${proposal.duplicate ? ' is-duplicate' : ''}`} data-testid="harvest-proposal">
                  <label className="harvest-proposal-head">
                    <input
                      type="checkbox"
                      data-testid="harvest-pick"
                      checked={checked.has(i)}
                      disabled={proposal.duplicate}
                      onChange={() => props.onToggleProposal(i)}
                    />
                    <span className="harvest-proposal-title">{proposal.title}</span>
                    {proposal.duplicate && <span className="harvest-proposal-tag">уже есть</span>}
                  </label>
                  <ProposalBody body={proposal.body} />
                  {proposal.why && <p className="harvest-proposal-why">{proposal.why}</p>}
                </li>
              ))}
            </ul>
            {state.costUsd !== null && (
              <p className="harvest-note" data-testid="harvest-cost">
                {`Расход по оценке Claude Code: ${money(state.costUsd)} — в подписке это часть лимита.`}
              </p>
            )}
          </>
        )
      case 'error':
        return (
          <p className="harvest-note is-failed" role="alert" data-testid="harvest-error" data-reason={state.reason}>
            {harvestErrorText(state.reason, state.detail)}
          </p>
        )
    }
  }

  function foot(): JSX.Element | null {
    switch (state.step) {
      case 'loading':
        return null
      case 'preview':
        return (
          <footer className="sheet-foot">
            <button type="button" className="btn" onClick={props.onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="harvest-run"
              disabled={state.preview.prompts === 0}
              onClick={props.onRun}
            >
              Собрать
            </button>
          </footer>
        )
      case 'running':
        return (
          <footer className="sheet-foot">
            <button type="button" className="btn" data-testid="harvest-stop" onClick={props.onStop}>
              Остановить
            </button>
          </footer>
        )
      case 'results':
        return (
          <footer className="sheet-foot">
            <button type="button" className="btn" onClick={props.onClose}>
              Закрыть
            </button>
            {state.proposals.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                data-testid="harvest-save"
                disabled={checked.size === 0}
                onClick={props.onSave}
              >
                {`Сохранить отмеченные (${checked.size})`}
              </button>
            )}
          </footer>
        )
      case 'error':
        return (
          <footer className="sheet-foot">
            <button type="button" className="btn" onClick={props.onClose}>
              Закрыть
            </button>
            <button type="button" className="btn btn-primary" data-testid="harvest-retry" onClick={props.onRetry}>
              Попробовать снова
            </button>
          </footer>
        )
    }
  }
}

/**
 * «Собрать мои шаблоны»: first what would be read, then one query to Claude,
 * then the proposals to tick. Closing while Claude is asked stops the query.
 */
export function HarvestSheet({
  onClose,
  onSaved,
  onFocusLost
}: {
  onClose(): void
  onSaved(count: number): void
  onFocusLost?(): void
}): JSX.Element {
  const [state, setState] = useState<HarvestState>({ step: 'loading' })
  const [projects, setProjects] = useState<HarvestProject[]>([])
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [showItems, setShowItems] = useState(false)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const running = useRef(false)
  /** The latest preview request; an older answer that lands later is dropped. */
  const ask = useRef(0)

  const load = useCallback(async (left: Set<string>): Promise<void> => {
    const n = ++ask.current
    setState({ step: 'loading' })
    try {
      const preview = await window.qclod.harvestPreview([...left])
      if (n !== ask.current) return
      // The first look keeps every project for its checkbox.
      setProjects((before) => (before.length === 0 && left.size === 0 ? preview.projects : before))
      setState({ step: 'preview', preview })
    } catch (err) {
      if (n !== ask.current) return
      setState({ step: 'error', reason: 'failed', detail: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  useEffect(() => {
    void load(new Set())
  }, [load])

  const close = (): void => {
    if (running.current) void window.qclod.harvestCancel()
    onClose()
  }

  const run = async (): Promise<void> => {
    if (state.step !== 'preview') return
    const preview = state.preview
    running.current = true
    setState({ step: 'running', preview })
    let outcome
    try {
      outcome = await window.qclod.harvestRun([...excluded])
    } catch (err) {
      outcome = { kind: 'error' as const, reason: 'failed' as const, detail: err instanceof Error ? err.message : String(err) }
    } finally {
      running.current = false
    }
    if (outcome.kind === 'ok') {
      setChecked(new Set())
      setState({ step: 'results', proposals: outcome.proposals, costUsd: outcome.costUsd })
    } else if (outcome.kind === 'empty') {
      setState({ step: 'results', proposals: [], costUsd: null })
    } else if (outcome.reason === 'cancelled') {
      // Stopped by the person: quietly back to what would be read.
      void load(excluded)
    } else {
      setState({ step: 'error', reason: outcome.reason, ...(outcome.detail ? { detail: outcome.detail } : {}) })
    }
  }

  const save = async (): Promise<void> => {
    if (state.step !== 'results') return
    const drafts: TemplateDraft[] = state.proposals
      .filter((p, i) => checked.has(i) && !p.duplicate)
      .map((p) => ({ title: p.title, body: p.body, origin: 'harvest' }))
    if (drafts.length === 0) return
    const count = await window.qclod.templatesSaveMany(drafts)
    onSaved(count)
  }

  return (
    <HarvestSheetView
      state={state}
      projects={projects}
      excluded={excluded}
      showItems={showItems}
      checked={checked}
      onToggleProject={(key) => {
        const next = new Set(excluded)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        setExcluded(next)
        void load(next)
      }}
      onToggleShow={() => setShowItems((v) => !v)}
      onRun={() => void run()}
      onStop={() => void window.qclod.harvestCancel()}
      onClose={close}
      onToggleProposal={(i) => {
        const next = new Set(checked)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        setChecked(next)
      }}
      onSave={() => void save()}
      onRetry={() => void load(excluded)}
      {...(onFocusLost ? { onFocusLost } : {})}
    />
  )
}
