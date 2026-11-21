import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CircleStop } from 'lucide-react'
import type { CostRates, RibbonItem, SubagentItem, SubagentStopResult } from '../../../shared/types'
import { agentNodes, type AgentNode } from '../../agents/agentModel'
import { subRibbon } from '../../agents/subRibbon'
import { cardAnswers } from '../../chat/cardAnswers'
import { Markdown } from '../../markdown/Markdown'
import { useAppStore } from '../../state/useAppStore'
import { Ribbon } from '../Ribbon'
import { STATE_ICON } from '../SubagentCard'
import { agentDetails, stateWithTime } from './AgentNodeView'
import { useNow } from '../../agents/useNow'

/** Why «Остановить» did not stop it. 'stopping' and 'not-running' need no words: the card follows. */
export const STOP_REFUSAL: Partial<Record<SubagentStopResult, string>> = {
  failed: 'Не удалось остановить',
  unsupported: 'Этот Claude Code не умеет останавливать такого агента',
  'not-started': 'Агент ещё запускается — подождите секунду'
}

interface Props {
  tabId: string
  card: SubagentItem
  /** The whole ribbon of the tab: the agent's own part is cut from it here. */
  items: RibbonItem[]
  costRates: CostRates | null
  onBack: () => void
}

/**
 * A subagent's own ribbon, read as a chat of its own (F4): who it is and how
 * it is going on top, what the main agent asked of it folded under that, and
 * its steps as the main ribbon draws them. Its input stands where the chat's
 * did (ChatPane swaps it in).
 */
export function AgentView({ tabId, card, items, costRates, onBack }: Props): JSX.Element {
  const own = useMemo(() => subRibbon(items, card.id), [items, card.id])
  // The node of the card: its parent and runs as the graph sees them.
  const node = useMemo<AgentNode | undefined>(() => agentNodes([card]).at(0), [card])
  const running = card.state === 'running'
  const now = useNow(running)
  const cwd = useAppStore((s) => s.tabs.find((t) => t.id === tabId)?.cwd ?? '')
  const answers = useMemo(() => cardAnswers(tabId), [tabId])
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const Icon = STATE_ICON[card.state]
  const back = useRef<HTMLButtonElement | null>(null)

  // The node that opened it is gone with the graph: the focus starts on the way back.
  useEffect(() => back.current?.focus(), [card.id])

  // «Останавливаю…» lasts until the card itself stops running (or another card is shown).
  useEffect(() => {
    setStopping(false)
    setStopError(null)
  }, [card.id, running])

  async function stop(): Promise<void> {
    if (stopping) return
    setStopping(true)
    setStopError(null)
    let result: SubagentStopResult
    try {
      result = await window.qclod.stopSubagent(tabId, card.id)
    } catch {
      result = 'failed'
    }
    // 'stopping': the CLI's frame will end the card; 'not-running': the card is about to follow.
    const refusal = STOP_REFUSAL[result]
    if (refusal) {
      setStopping(false)
      setStopError(refusal)
    }
  }

  const details = node ? agentDetails(node, costRates, true) : []
  return (
    <div className="agent-view" data-testid="agent-view">
      <div className="agent-view-head">
        <button
          ref={back}
          type="button"
          className="agent-back"
          aria-label="Назад ко всем агентам"
          title="Назад ко всем агентам"
          onClick={onBack}
        >
          <ArrowLeft size={14} aria-hidden="true" />
          Все агенты
        </button>
        <div className="agent-view-title">
          <span className="agent-node-kind">{card.name}</span>
          {card.background && <span className="agent-badge">фон</span>}
          {(card.runs ?? 1) > 1 && <span className="agent-badge">запуск {card.runs}</span>}
          <span className="agent-view-task" title={card.task}>
            {card.task}
          </span>
        </div>
        <div className={`agent-view-state is-${card.state}`}>
          <Icon size={13} className={running ? 'tool-spin' : undefined} aria-hidden="true" />
          <span>{node ? stateWithTime(node, now) : ''}</span>
          {running && node?.summary ? <span className="agent-node-summary"> · {node.summary}</span> : null}
        </div>
        {details.length > 0 && (
          <div className="agent-view-details" data-testid="agent-details">
            {details.join(' · ')}
          </div>
        )}
        {running && (
          <div className="agent-view-actions">
            <button
              type="button"
              className="agent-stop"
              data-testid="agent-stop"
              title="Остановить этого агента; главный агент продолжит"
              disabled={stopping}
              onClick={() => void stop()}
            >
              <CircleStop size={14} aria-hidden="true" />
              {stopping ? 'Останавливаю…' : 'Остановить'}
            </button>
            {stopError && (
              <span className="agent-stop-error" data-testid="agent-stop-error" role="status">
                {stopError}
              </span>
            )}
          </div>
        )}
      </div>

      {card.prompt ? (
        <details className="agent-prompt">
          <summary>Задача от главного агента</summary>
          <div className="agent-prompt-text">
            <Markdown text={card.prompt} tabId={tabId} />
          </div>
        </details>
      ) : null}

      <div className="agent-view-ribbon">
        <Ribbon key={card.id} items={own} cwd={cwd} tabId={tabId} answers={answers} />
      </div>
    </div>
  )
}
