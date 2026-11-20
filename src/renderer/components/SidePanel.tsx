import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { LimitWindow, McpServerInfo, PanelData, RemoteInfo } from '../../shared/types'
import { plural, untilReset } from '../../shared/format'
import { contextLevel } from '../chat/contextLevel'
import { LevelIcon, levelLabel } from '../ui/icons'
import { ContextBreakdown } from './ContextBreakdown'
import { RemoteSection } from './RemoteSection'
import '../ui/meter.css'
import './SidePanel.css'

/** Marks the pane's panel button: a press on it is not a click «past» the drawer. */
export const PANEL_TOGGLE_ATTR = 'data-panel-toggle'

interface Props {
  data: PanelData
  started: boolean
  /** Remote Control of the tab the panel shows. */
  remote: RemoteInfo
  onRemote: (enabled: boolean) => void
  /** Beside the conversation, or slid out over it in a narrow pane. */
  mode: 'docked' | 'drawer'
  /** The drawer asks to close: Esc, or a press outside it. */
  onClose: () => void
}

const MCP_LABEL: Record<McpServerInfo['status'], string> = {
  connected: 'подключён',
  connecting: 'подключается',
  failed: 'упал',
  'needs-auth': 'требует входа',
  pending: 'ждёт',
  disabled: 'выключен'
}

/** What needs the person comes first; the connected ones fold into one line. */
const MCP_ORDER: Record<McpServerInfo['status'], number> = {
  failed: 0,
  'needs-auth': 1,
  connecting: 2,
  pending: 3,
  disabled: 4,
  connected: 5
}

function money(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

/**
 * A pane's right-hand panel (spec E5: each half of a split has its own):
 * how much room is left, what the plan allows, what is plugged in, and the
 * session it all belongs to.
 *
 * Every number here has a named source (spec 6.5). Where there is no number
 * yet the panel says so rather than showing a confident zero — the difference
 * between «nothing has happened» and «it is zero» matters to someone deciding
 * whether to keep going. Subagents are not here: the pane's «Агенты» layer
 * shows them (этап 4).
 */
export function SidePanel({ data, started, remote, onRemote, mode, onClose }: Props): JSX.Element {
  const self = useRef<HTMLElement | null>(null)

  // A drawer is out of the way at once: Esc, or a press anywhere outside it.
  useEffect(() => {
    if (mode !== 'drawer') return
    const onKey = (ev: KeyboardEvent): void => {
      // A list open inside the pane keeps its own Esc.
      if (ev.key === 'Escape' && !ev.defaultPrevented) onClose()
    }
    const onPress = (ev: PointerEvent): void => {
      const target = ev.target as Element | null
      if (!target || self.current?.contains(target)) return
      // The pane's own panel button closes it by itself.
      if (target.closest?.(`[${PANEL_TOGGLE_ATTR}]`)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPress)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPress)
    }
  }, [mode, onClose])

  const chosen = data.models.find((m) => m.value === data.model)
  // A bridge that is on, or trying to be, leads the panel: its link and QR are what is wanted then.
  const remoteSection = <RemoteSection remote={remote} onToggle={onRemote} />
  const remoteFirst = remote.state !== 'off'
  return (
    <aside className="panel" data-testid="side-panel" data-mode={mode} ref={self} aria-label="Панель сессии">
      {remoteFirst && remoteSection}

      <Section title="Контекст">
        {data.context ? (
          <div data-testid="panel-context" data-level={contextLevel(data.context.percent)}>
            <div className="panel-line">
              {/* Worked out from the record until the tab's agent reports its own. */}
              <span>
                <span className="panel-context-alert">
                  <LevelIcon
                    level={contextLevel(data.context.percent)}
                    label={levelLabel('context', contextLevel(data.context.percent))}
                  />
                </span>
                {data.context.estimated ? '≈ ' : ''}
                {data.context.percent}% из {Math.round(data.context.max / 1000)}k
                {data.context.estimated ? ' · по записи' : ''}
              </span>
              <span className="panel-dim">{data.context.used.toLocaleString('ru-RU')}</span>
            </div>
            <ContextBreakdown context={data.context} />
          </div>
        ) : (
          <Empty started={started} />
        )}
      </Section>

      <Section title="Лимиты">
        {data.limits.fiveHour || data.limits.sevenDay ? (
          <div data-testid="panel-limits">
            <Limit label="5 часов" window={data.limits.fiveHour} />
            <Limit label="Неделя" window={data.limits.sevenDay} />
          </div>
        ) : (
          <Empty started={started} />
        )}
      </Section>

      <Section title="MCP">
        {data.mcp.length > 0 ? <McpList servers={data.mcp} /> : <Empty started={started} text="Серверов нет" />}
      </Section>

      {!remoteFirst && remoteSection}

      {/* One row, not a section: what the session runs on and what it has cost. */}
      <div className="panel-session" data-testid="panel-session">
        <div className="panel-session-title">Сессия</div>
        {data.model || started ? (
          <div className="panel-line">
            {/* Asked for at start; the answer is a moment away, not a turn away. */}
            <span data-testid="panel-model">{data.model ? (chosen?.displayName ?? data.model) : '…'}</span>
            {data.cost && (
              // A resumed conversation is counted by the CLI from when it was opened.
              <span data-testid="panel-cost" className="panel-dim" title={data.cost.sinceOpen ? 'С момента открытия' : 'За сессию'}>
                {money(data.cost.session)}
              </span>
            )}
          </div>
        ) : (
          <Empty started={started} />
        )}
        {data.projectSettings && (
          <div className="panel-project" data-testid="panel-project-settings">
            <div className="panel-line">
              <span>
                {`Настройки проекта: ${data.projectSettings.hooks} ${plural(data.projectSettings.hooks, 'хук', 'хука', 'хуков')}`}
              </span>
            </div>
            {data.projectSettings.mcpServers.length > 0 && (
              <div className="panel-line">
                <span>свои MCP</span>
                <span className="panel-dim">{data.projectSettings.mcpServers.join(', ')}</span>
              </div>
            )}
            <p className="panel-note">Загружаются вместе с проектом и работают от вашего имени.</p>
          </div>
        )}
      </div>
    </aside>
  )
}

/** Failed, waiting for a sign-in, connecting — each by name; the connected ones as «N подключено». */
function McpList({ servers }: { servers: McpServerInfo[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const attention = servers
    .filter((s) => s.status !== 'connected')
    .sort((a, b) => MCP_ORDER[a.status] - MCP_ORDER[b.status])
  const connected = servers.filter((s) => s.status === 'connected')
  return (
    <div data-testid="panel-mcp">
      {attention.length > 0 && <McpRows servers={attention} />}
      {connected.length > 0 && (
        <>
          <button
            type="button"
            className="panel-mcp-ok"
            data-testid="panel-mcp-ok"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            <span>{`${connected.length} подключено`}</span>
          </button>
          {open && <McpRows servers={connected} />}
        </>
      )}
    </div>
  )
}

function McpRows({ servers }: { servers: McpServerInfo[] }): JSX.Element {
  return (
    <ul className="panel-mcp">
      {servers.map((server) => (
        <li key={server.name} className={`is-${server.status}`}>
          <span className="panel-mcp-dot" aria-hidden />
          <span className="panel-mcp-name">{server.name}</span>
          <span className="panel-dim">{MCP_LABEL[server.status] ?? server.status}</span>
        </li>
      ))}
    </ul>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Empty({ started, text }: { started: boolean; text?: string }): JSX.Element {
  return (
    <div className="panel-empty" data-testid="panel-empty">
      {text ?? (started ? 'Появится после первого ответа' : 'Появится после запуска')}
    </div>
  )
}

/** The same thresholds as the status line under the input (80% and 90%). */
function Bar({ percent }: { percent: number }): JSX.Element {
  return (
    <div className="meter panel-bar" data-level={contextLevel(percent)}>
      <div className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  )
}

function Limit({ label, window }: { label: string; window: LimitWindow | null }): JSX.Element {
  if (!window) return <div className="panel-line panel-dim">{label} — нет данных</div>
  const percent = Math.round(window.utilization * 100)
  return (
    <div className="panel-limit">
      <div className="panel-line">
        <span>{label}</span>
        <span>{percent}%</span>
      </div>
      <Bar percent={percent} />
      <div className="panel-line panel-dim">
        <span>сброс</span>
        <span>{untilReset(window.resetsAt)}</span>
      </div>
    </div>
  )
}
