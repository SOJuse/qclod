import { useState } from 'react'
import { Check, CircleAlert, CircleDashed, CircleStop, LoaderCircle, type LucideIcon } from 'lucide-react'
import { compactNumber, plural, seconds } from '../../shared/format'
import type { RibbonItem, SubagentState } from '../../shared/types'
import { AGENT_STATE_LABEL } from './agentState'
import { CategoryIcon } from '../ui/icons'
import { Markdown } from '../markdown/Markdown'
import { ToolCard } from './ToolCard'
import './SubagentCard.css'

type SubagentItem = Extract<RibbonItem, { kind: 'subagent' }>

const STATE_ICON: Record<SubagentState, LucideIcon> = {
  running: LoaderCircle,
  done: Check,
  failed: CircleAlert,
  stopped: CircleStop,
  unfinished: CircleDashed
}

/**
 * How many steps an opened card draws at once. A subagent can make hundreds
 * of calls; the newest are what is worth reading, the rest wait behind a
 * button, so a long run costs the page no more than a short one.
 */
export const STEP_PAGE = 50

/** One shared empty list, so a card with no steps does not get a new one each render. */
export const NO_STEPS: RibbonItem[] = []

/** A step is something the agent did: a call, or another agent it started. Its words are not counted. */
function isStep(item: RibbonItem): boolean {
  return item.kind === 'tool' || item.kind === 'toolError' || item.kind === 'subagent'
}

/** What an opened card draws: its steps and its words. Its thoughts are not shown, so they take no place. */
function isDrawn(item: RibbonItem): boolean {
  return isStep(item) || item.kind === 'agentText'
}

/** «ещё 10 шагов» when only calls are hidden; «ещё 11 записей» when words are among them. */
function moreLabel(hidden: RibbonItem[]): string {
  const calls = hidden.reduce((n, entry) => (isStep(entry) ? n + 1 : n), 0)
  const n = hidden.length
  return calls === n
    ? `ещё ${n} ${plural(n, 'шаг', 'шага', 'шагов')}`
    : `ещё ${n} ${plural(n, 'запись', 'записи', 'записей')}`
}

/** The tool a running agent is on: what it last reported, or else the newest call in its ribbon. */
function currentTool(item: SubagentItem, steps: RibbonItem[]): string {
  if (item.lastTool) return item.lastTool
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!
    if (step.kind === 'tool' || step.kind === 'toolError') return step.name
  }
  return ''
}

/**
 * A subagent: who it is, what it was asked, how it is going, and — opened in
 * place — its own ribbon of steps with the report it wrote back at the bottom.
 *
 * The steps are drawn only while the card is open: a closed card is one line
 * however long the agent worked. A nested agent is the same card again, one
 * level in, with its own steps from the same map.
 */
export function SubagentCard({
  item,
  steps,
  byParent,
  cwd,
  tabId
}: {
  item: SubagentItem
  /** Its own items, in order (childrenByParent). */
  steps: RibbonItem[]
  /** Every agent's items, for the agents it started. */
  byParent: ReadonlyMap<string, RibbonItem[]>
  cwd: string
  tabId: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(STEP_PAGE)

  const stepCount = steps.reduce((n, step) => (isStep(step) ? n + 1 : n), 0)
  const running = item.state === 'running'
  const StateIcon = STATE_ICON[item.state]
  const tool = running ? currentTool(item, steps) : ''
  const failure = item.state === 'failed' && item.summary ? item.summary : ''

  const stats = [
    item.durationMs ? seconds(item.durationMs) : null,
    item.tokens ? `${compactNumber(item.tokens)} токенов` : null,
    // The run's own total, when it says more than the steps in view do.
    item.toolCalls && item.toolCalls !== stepCount
      ? `${item.toolCalls} ${plural(item.toolCalls, 'вызов', 'вызова', 'вызовов')}`
      : null
  ]
    .filter(Boolean)
    .join(' · ')

  // Only an opened card pays for sorting its entries.
  const entries = open ? steps.filter(isDrawn) : NO_STEPS
  const hiddenCount = Math.max(0, entries.length - shown)
  const visible = hiddenCount > 0 ? entries.slice(hiddenCount) : entries
  // Folded and finished, the head says in one line what came of it.
  const outcome = !open && item.state === 'done' ? item.summary : ''

  return (
    <details
      className={`subagent-card is-${item.state}`}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="subagent-head" data-testid="subagent-head">
        <span className="subagent-chip">
          <CategoryIcon category="agent" />
        </span>
        <span className="subagent-kind">{item.name}</span>
        <span className="subagent-task" title={item.task}>
          {item.task}
        </span>
        <span className="subagent-state">
          <StateIcon size={14} className={running ? 'tool-spin' : undefined} aria-hidden="true" />
          {AGENT_STATE_LABEL[item.state]}
          {tool ? <span className="subagent-tool"> · {tool}</span> : null}
          {failure ? <span className="subagent-failure"> · {failure}</span> : null}
        </span>
        {stats && (
          <span className="subagent-stats" data-testid="subagent-stats">
            {stats}
          </span>
        )}
        {stepCount > 0 && (
          <span className="subagent-step-count" data-testid="subagent-step-count">
            {stepCount} {plural(stepCount, 'шаг', 'шага', 'шагов')}
          </span>
        )}
        {outcome && (
          <span className="subagent-summary" data-testid="subagent-summary" title={outcome}>
            {outcome}
          </span>
        )}
      </summary>

      {open && (
        <div className="subagent-body">
          {entries.length > 0 && (
            <div className="subagent-steps" data-testid="subagent-steps">
              {hiddenCount > 0 && (
                <button
                  type="button"
                  className="subagent-more"
                  data-testid="subagent-more"
                  onClick={() => setShown((n) => n + STEP_PAGE)}
                >
                  {moreLabel(entries.slice(0, hiddenCount))}
                </button>
              )}
              {visible.map((step) => (
                <Step key={step.id} step={step} byParent={byParent} cwd={cwd} tabId={tabId} />
              ))}
            </div>
          )}
          {item.report ? (
            <div className="subagent-report" data-testid="subagent-report">
              <div className="subagent-report-title">Отчёт</div>
              <Markdown text={item.report} tabId={tabId} />
            </div>
          ) : null}
        </div>
      )}
    </details>
  )
}

function Step({
  step,
  byParent,
  cwd,
  tabId
}: {
  step: RibbonItem
  byParent: ReadonlyMap<string, RibbonItem[]>
  cwd: string
  tabId: string
}): JSX.Element | null {
  switch (step.kind) {
    case 'tool':
    case 'toolError':
      return (
        <div data-testid={`ribbon-${step.kind}`}>
          <ToolCard item={step} cwd={cwd} tabId={tabId} compact />
        </div>
      )
    case 'agentText':
      return (
        <div className="subagent-text" data-testid="ribbon-agentText">
          <Markdown text={step.text} tabId={tabId} streaming={step.streaming} />
        </div>
      )
    case 'subagent':
      return (
        <div data-testid="ribbon-subagent">
          <SubagentCard
            item={step}
            steps={byParent.get(step.id) ?? NO_STEPS}
            byParent={byParent}
            cwd={cwd}
            tabId={tabId}
          />
        </div>
      )
    default:
      return null
  }
}

