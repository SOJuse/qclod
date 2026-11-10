import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { RibbonItem, SessionStatus, TabId } from '../../shared/types'
import { plural } from '../../shared/format'
import { nowActivity, type NowActivity } from '../chat/nowActivity'
import { CategoryIcon, NOW_ICON } from '../ui/icons'
import { PathLink } from '../paths/PathLink'
import { useResolvedPaths } from '../paths/useResolvedPaths'
import './NowLine.css'

interface Props {
  tabId: TabId
  status: SessionStatus
  /** When this turn started, epoch ms. */
  since: number | undefined
  items: RibbonItem[]
}

/** 0:07, 2:05, 61:40 — a turn's time at a glance. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function agentsLabel(n: number): string {
  return `${n} ${plural(n, 'агент', 'агента', 'агентов')}`
}

function NowIcon({ category }: { category: NowActivity['category'] }): JSX.Element {
  if (category === 'thinking' || category === 'writing' || category === 'waiting') {
    const { icon: Icon, color } = NOW_ICON[category]
    return <Icon size={14} color={color} aria-hidden="true" />
  }
  return <CategoryIcon category={category} />
}

/**
 * What the agent is doing this very moment, above the input: «Читает
 * index.ts», «Запускает npm test», «Ждёт ответа», with the turn's clock.
 * Subagents still at work are counted on a button that lists them; between
 * turns, background agents keep the line alone, without a clock.
 */
export function NowLine({ tabId, status, since, items }: Props): JSX.Element | null {
  // The clock re-renders every second; the ribbon is scanned only when it changes.
  const now = useMemo(() => nowActivity(items, status), [items, status])
  const inTurn = status === 'busy' || status === 'waiting'
  const [, setTick] = useState(0)
  const [listOpen, setListOpen] = useState(false)
  const self = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!inTurn) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [inTurn])

  const agentCount = now?.runningAgents.length ?? 0
  useEffect(() => {
    if (agentCount === 0) setListOpen(false)
  }, [agentCount])

  // The list closes on a click anywhere else.
  useEffect(() => {
    if (!listOpen) return
    const away = (e: MouseEvent): void => {
      if (!self.current?.contains(e.target as Node)) setListOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [listOpen])

  const path = now?.objectKind === 'path' ? now.path : undefined
  const paths = useMemo(() => (path ? [path] : []), [path])
  const target = useResolvedPaths(tabId, paths).get(path ?? '')

  if (!now) return null

  return (
    <div
      ref={self}
      className={`now-line${inTurn ? ' is-turn' : ''}`}
      data-testid="now-line"
      data-category={now.category}
      title={inTurn ? 'Esc — прервать' : undefined}
    >
      <span className="now-chip">
        <NowIcon category={now.category} />
      </span>

      {/* Read out when it changes; the clock stays outside so it is not read every second. */}
      <span className="now-say" aria-live="polite">
        {now.verb && (
          <span className="now-what" data-testid="now-what">
            {now.verb}
          </span>
        )}

        {now.objectKind !== 'none' && (
          <span
            className={`now-object${now.objectKind === 'text' ? '' : ' is-mono'}`}
            data-testid="now-object"
            title={now.path ?? now.object}
          >
            {target ? (
              <PathLink tabId={tabId} target={target}>
                {now.object}
              </PathLink>
            ) : (
              now.object
            )}
          </span>
        )}

        {!inTurn && agentCount > 0 && (
          <span className="now-background" data-testid="now-background">
            Работают в фоне
          </span>
        )}
      </span>

      <span className="now-fill" />

      {agentCount > 0 && (
        <button
          type="button"
          className={`now-agents${listOpen ? ' is-open' : ''}`}
          data-testid="now-agents"
          aria-expanded={listOpen}
          title={listOpen ? 'Скрыть список агентов' : 'Показать список агентов'}
          onClick={() => setListOpen((open) => !open)}
        >
          <CategoryIcon category="agent" size={13} />
          <span>{agentsLabel(agentCount)}</span>
          {listOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}
        </button>
      )}

      {inTurn && since !== undefined && (
        <span className="now-time" data-testid="now-time">
          {clock(Date.now() - since)}
        </span>
      )}

      {listOpen && agentCount > 0 && (
        <ul className="now-agents-list" data-testid="now-agents-list">
          {now.runningAgents.map((agent) => (
            <li key={agent.id} className="now-agent">
              <span className="now-agent-type">{agent.name}</span>
              <span className="now-agent-task" title={agent.task}>
                {agent.task}
              </span>
              {agent.lastTool && <span className="now-agent-tool">{agent.lastTool}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
