import type { LimitWindow, McpServerInfo, PanelData, RemoteInfo, SubagentState } from '../../shared/types'
import { plural, untilReset } from '../../shared/format'
import { contextLevel } from '../chat/contextLevel'
import { PanelRightClose } from 'lucide-react'
import { LevelIcon, levelLabel } from '../ui/icons'
import { hint } from '../app/shortcuts'
import { ContextBreakdown } from './ContextBreakdown'
import { AGENT_STATE_LABEL } from './agentState'
import { RemoteSection } from './RemoteSection'
import '../ui/meter.css'
import './SidePanel.css'

interface Props {
  data: PanelData
  started: boolean
  onClose: () => void
  /** Subagents this session has run, newest last. */
  agents: AgentRun[]
  /** Remote Control of the tab the panel shows. */
  remote: RemoteInfo
  onRemote: (enabled: boolean) => void
}

const MCP_LABEL: Record<McpServerInfo['status'], string> = {
  connected: 'подключён',
  connecting: 'подключается',
  failed: 'упал',
  'needs-auth': 'требует входа',
  pending: 'ждёт',
  disabled: 'выключен'
}

export interface AgentRun {
  id: string
  name: string
  task: string
  state: SubagentState
  tokens?: number
  durationMs?: number
  toolCalls?: number
  lastTool?: string
  summary?: string
}


function shortDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} с`
  const minutes = Math.floor(total / 60)
  return total % 60 === 0 ? `${minutes} мин` : `${minutes} мин ${total % 60} с`
}

function shortNumber(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function money(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

/**
 * The right-hand panel: what this session costs, how much room is left, and
 * what is plugged into it.
 *
 * Every number here has a named source (spec 6.5). Where there is no number
 * yet the panel says so rather than showing a confident zero — the difference
 * between «nothing has happened» and «it is zero» matters to someone deciding
 * whether to keep going.
 */
export function SidePanel({ data, started, agents, remote, onRemote, onClose }: Props): JSX.Element {
  // Model, effort and mode are switched in the status line under the input;
  // the panel names the model and leaves the switching there.
  const chosen = data.models.find((m) => m.value === data.model)
  // A bridge that is on, or trying to be, leads the panel; off, it waits at the end.
  const remoteSection = <RemoteSection remote={remote} onToggle={onRemote} />
  const remoteFirst = remote.state !== 'off'
  return (
    <aside className="panel" data-testid="side-panel">
      <header className="panel-head">
        <span>Сессия</span>
        <button type="button" data-testid="panel-close" aria-label="Скрыть панель" title={hint('Скрыть панель', 'togglePanel')} onClick={onClose}>
          <PanelRightClose size={16} aria-hidden="true" />
        </button>
      </header>

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

      <Section title="Расход">
        {data.cost ? (
          <div className="panel-line" data-testid="panel-cost">
            {/* A resumed conversation is counted by the CLI from when it was opened. */}
            <span>{data.cost.sinceOpen ? 'с момента открытия' : 'за сессию'}</span>
            <span>{money(data.cost.session)}</span>
          </div>
        ) : (
          <Empty started={started} />
        )}
      </Section>

      <Section title="Лимиты подписки">
        {data.limits.fiveHour || data.limits.sevenDay ? (
          <div data-testid="panel-limits">
            <Limit label="5 часов" window={data.limits.fiveHour} />
            <Limit label="7 дней" window={data.limits.sevenDay} />
          </div>
        ) : (
          <Empty started={started} />
        )}
      </Section>

      <Section title="Модель">
        {data.model ? (
          <div className="panel-line" data-testid="panel-model">
            <span>{chosen?.displayName ?? data.model}</span>
          </div>
        ) : started ? (
          // Asked for at start; the answer is a moment away, not a turn away.
          <div className="panel-line" data-testid="panel-model">
            <span>…</span>
          </div>
        ) : (
          <Empty started={started} />
        )}
      </Section>

      <Section title="Агенты">
        {agents.length === 0 ? (
          <Empty started={started} text="Агентов нет" />
        ) : (
          <ul className="panel-agents" data-testid="panel-agents">
            {agents.map((agent) => (
              <li key={agent.id} className={`is-${agent.state}`}>
                <div className="panel-line">
                  <span className="panel-agent-kind">{agent.name}</span>
                  <span className="panel-dim">
                    {AGENT_STATE_LABEL[agent.state]}
                  </span>
                </div>
                <div className="panel-agent-task">{agent.task}</div>
                {agent.state === 'running' ? (
                  (agent.lastTool || agent.toolCalls) && (
                    <div className="panel-line panel-dim panel-agent-stats">
                      <span>{agent.lastTool ?? ''}</span>
                      <span>{agent.toolCalls ? `${agent.toolCalls} ${plural(agent.toolCalls, 'вызов', 'вызова', 'вызовов')}` : ''}</span>
                    </div>
                  )
                ) : agent.state === 'failed' ? (
                  agent.summary && <div className="panel-dim panel-agent-stats">{agent.summary}</div>
                ) : (
                  (agent.durationMs || agent.tokens) && (
                    <div className="panel-line panel-dim panel-agent-stats">
                      <span>{agent.durationMs ? shortDuration(agent.durationMs) : ''}</span>
                      <span>{agent.tokens ? `${shortNumber(agent.tokens)} токенов` : ''}</span>
                    </div>
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="MCP и плагины">
        {data.mcp.length > 0 ? (
          <ul className="panel-mcp" data-testid="panel-mcp">
            {data.mcp.map((server) => (
              <li key={server.name} className={`is-${server.status}`}>
                <span className="panel-mcp-dot" aria-hidden />
                <span className="panel-mcp-name">{server.name}</span>
                <span className="panel-dim">{MCP_LABEL[server.status] ?? server.status}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty started={started} text="Серверов нет" />
        )}
      </Section>

      {data.projectSettings && (
        <Section title="Настройки этой папки">
          <div className="panel-project" data-testid="panel-project-settings">
            {data.projectSettings.hooks > 0 && (
              <div className="panel-line">
                <span>хуков</span>
                <span>{data.projectSettings.hooks}</span>
              </div>
            )}
            {data.projectSettings.mcpServers.length > 0 && (
              <div className="panel-line">
                <span>свои MCP</span>
                <span className="panel-dim">{data.projectSettings.mcpServers.join(', ')}</span>
              </div>
            )}
            <p className="panel-note">Загружаются вместе с проектом и работают от вашего имени.</p>
          </div>
        </Section>
      )}

      {!remoteFirst && remoteSection}
    </aside>
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
