import { useEffect, useMemo, useRef } from 'react'
import type { CostRates, RibbonItem, SubagentItem } from '../../../shared/types'
import { agentNodes } from '../../agents/agentModel'
import { scrollTarget } from '../../agents/graphLayout'
import { useNow } from '../../agents/useNow'
import { useAppStore, type AgentsView } from '../../state/useAppStore'
import { StateView } from '../../ui/StateView'
import { AgentGraph } from './AgentGraph'
import { AgentTimeline } from './AgentTimeline'
import { AgentView } from './AgentView'
import './AgentsLayer.css'

const VIEWS: Array<{ view: AgentsView; label: string; hint: string }> = [
  { view: 'graph', label: 'Граф', hint: 'Кто кого запустил' },
  { view: 'timeline', label: 'Таймлайн', hint: 'Кто когда работал' }
]

interface Props {
  tabId: string
  items: RibbonItem[]
  costRates: CostRates | null
  /** The card whose own ribbon is open (layerByTab[tabId].agentId); absent — all the agents. */
  agentId?: string
}

/**
 * The layer's body: one agent's own ribbon if `agentId` names a subagent card
 * of this chat, otherwise all of them. A card that is gone (a new session)
 * falls back to all of them.
 */
export function AgentsLayer({ agentId, ...rest }: Props): JSX.Element {
  const card = useMemo(
    () => (agentId === undefined ? undefined : rest.items.find((i): i is SubagentItem => i.kind === 'subagent' && i.id === agentId)),
    [agentId, rest.items]
  )
  if (card) {
    return (
      <AgentView
        {...rest}
        card={card}
        onBack={() => useAppStore.getState().openAgents(rest.tabId)}
      />
    )
  }
  return <AgentsOverview {...rest} />
}

/**
 * The chat's subagents over its ribbon — the body of the pane's layer
 * (сверка F9): a graph or a timeline, chosen once for every pane. The pinned
 * cards and the input stay in view under it; Esc and «Закрыть» are the
 * layer's own (PaneLayer).
 */
function AgentsOverview({ tabId, items, costRates }: Omit<Props, 'agentId'>): JSX.Element {
  const nodes = useMemo(() => agentNodes(items), [items])
  const running = nodes.reduce((n, node) => (node.state === 'running' ? n + 1 : n), 0)
  const view = useAppStore((s) => s.agentsView)
  const now = useNow(running > 0)
  const selected = useRef<HTMLButtonElement | null>(null)
  const tablist = useRef<HTMLDivElement | null>(null)
  const opened = useRef(false)

  // Opened, the focus is on the switch (PaneLayer leaves a focus already inside it);
  // switched by the arrows, it follows the chosen tab.
  useEffect(() => {
    if (!opened.current || tablist.current?.contains(document.activeElement)) selected.current?.focus()
    opened.current = true
  }, [view])

  // Opened or switched: the first working agent in view — with 10–15 of them
  // it may be well below the fold — or the main agent when none works. Not on
  // every step after that: the person may have scrolled away on purpose.
  const viewBox = useRef<HTMLDivElement | null>(null)
  const target = useRef<string | null>(null)
  target.current = scrollTarget(nodes)
  useEffect(() => {
    const box = viewBox.current
    if (!box) return
    const id = target.current
    const node = id === null ? undefined : [...box.querySelectorAll('[data-node-id]')].find((el) => el.getAttribute('data-node-id') === id)
    const el = node ?? box.querySelector('[data-testid="agent-graph-root"]') ?? box.firstElementChild
    el?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [view])

  const open = (id: string): void => useAppStore.getState().openAgents(tabId, id)
  const pick = (next: AgentsView): void => useAppStore.getState().setAgentsView(next)

  return (
    <div className="agents-layer" data-testid="agents-layer">
      <div className="agents-layer-bar">
        <span className="agents-layer-count" data-testid="agents-count">
          работают: {running} · всего: {nodes.length}
        </span>
        <div
          ref={tablist}
          className="agents-tabs"
          role="tablist"
          aria-label="Вид"
          onKeyDown={(ev) => {
            if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
            ev.preventDefault()
            pick(view === 'graph' ? 'timeline' : 'graph')
          }}
        >
          {VIEWS.map(({ view: v, label, hint }) => (
            <button
              key={v}
              ref={v === view ? selected : undefined}
              type="button"
              role="tab"
              aria-selected={v === view}
              tabIndex={v === view ? 0 : -1}
              className={`agents-tab${v === view ? ' is-selected' : ''}`}
              data-testid={`agents-view-${v}`}
              title={hint}
              onClick={() => pick(v)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {nodes.length === 0 ? (
        <StateView
          kind="empty"
          title="В этом чате ещё не было сабагентов"
          hint="Они появятся здесь, когда главный агент их запустит."
          testId="agents-empty"
        />
      ) : (
        <div ref={viewBox} className="agents-layer-view" role="tabpanel">
          {view === 'graph' ? (
            <AgentGraph nodes={nodes} now={now} costRates={costRates} onOpen={open} />
          ) : (
            <AgentTimeline nodes={nodes} now={now} onOpen={open} />
          )}
        </div>
      )}
    </div>
  )
}
