import { useEffect, useMemo, useRef, useState } from 'react'
import type { CostRates, RibbonItem } from '../../../shared/types'
import { agentNodes } from '../../agents/agentModel'
import { useAppStore, type AgentsView } from '../../state/useAppStore'
import { StateView } from '../../ui/StateView'
import { AgentGraph } from './AgentGraph'
import './AgentsLayer.css'

const VIEWS: Array<{ view: AgentsView; label: string }> = [
  { view: 'graph', label: 'Граф' },
  { view: 'timeline', label: 'Таймлайн' }
]

/**
 * The time, once a second while `active` and the window is in view; otherwise
 * it stands. A hidden window does not tick: nobody reads the clock there.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = (): void => {
      if (timer !== null || document.visibilityState !== 'visible') return
      setNow(Date.now())
      timer = setInterval(() => setNow(Date.now()), 1000)
    }
    const stop = (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const onVisibility = (): void => (document.visibilityState === 'visible' ? start() : stop())
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])
  return now
}

interface Props {
  tabId: string
  items: RibbonItem[]
  costRates: CostRates | null
}

/**
 * The chat's subagents over its ribbon — the body of the pane's layer
 * (сверка F9): a graph or a timeline, chosen once for every pane. The pinned
 * cards and the input stay in view under it; Esc and «Закрыть» are the
 * layer's own (PaneLayer).
 */
export function AgentsLayer({ tabId, items, costRates }: Props): JSX.Element {
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
          {VIEWS.map(({ view: v, label }) => (
            <button
              key={v}
              ref={v === view ? selected : undefined}
              type="button"
              role="tab"
              aria-selected={v === view}
              tabIndex={v === view ? 0 : -1}
              className={`agents-tab${v === view ? ' is-selected' : ''}`}
              data-testid={`agents-view-${v}`}
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
        <div className="agents-layer-view" role="tabpanel">
          {view === 'graph' ? <AgentGraph nodes={nodes} now={now} costRates={costRates} onOpen={open} /> : null}
        </div>
      )}
    </div>
  )
}
