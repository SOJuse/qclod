import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type EffortLevel,
  type LimitWindow,
  type McpServerInfo,
  type PanelData,
  type PermissionMode
} from '../../shared/types'
import './SidePanel.css'

interface Props {
  data: PanelData
  started: boolean
  onClose: () => void
  onSetMode: (mode: PermissionMode) => void
  onSetModel: (model: string) => void
  onSetEffort: (level: EffortLevel) => void
}

const MCP_LABEL: Record<McpServerInfo['status'], string> = {
  connected: 'подключён',
  connecting: 'подключается',
  failed: 'упал',
  'needs-auth': 'требует входа',
  pending: 'ждёт',
  disabled: 'выключен'
}

const EFFORT_LABEL: Record<string, string> = {
  low: 'низкое — быстро',
  medium: 'среднее',
  high: 'высокое',
  xhigh: 'очень высокое',
  max: 'максимум — долго'
}

const MODE_LABEL: Record<string, string> = {
  default: 'спрашивать',
  acceptEdits: 'принимать правки',
  plan: 'план',
  auto: 'автоматически',
  dontAsk: 'не спрашивать',
  bypassPermissions: 'без проверок'
}

function money(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`
}

/** «через 2 ч 15 мин», from a unix timestamp in seconds. */
function until(resetsAt: number): string {
  const minutes = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000))
  if (minutes < 60) return `через ${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `через ${hours} ч ${minutes % 60} мин`
  return `через ${Math.round(hours / 24)} дн`
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
export function SidePanel({
  data,
  started,
  onClose,
  onSetMode,
  onSetModel,
  onSetEffort
}: Props): JSX.Element {
  // Effort is a property of the chosen model: Opus offers more levels than
  // Sonnet, so the list follows the model rather than being fixed.
  const chosen = data.models.find((m) => m.value === data.model)
  const efforts = chosen?.supportedEffortLevels ?? EFFORT_LEVELS
  return (
    <aside className="panel" data-testid="side-panel">
      <header className="panel-head">
        <span>Сессия</span>
        <button type="button" data-testid="panel-close" aria-label="Скрыть панель" onClick={onClose}>
          ›
        </button>
      </header>

      <Section title="Контекст">
        {data.context ? (
          <div data-testid="panel-context">
            <Bar percent={data.context.percent} />
            <div className="panel-line">
              <span>{data.context.percent}% из {Math.round(data.context.max / 1000)}k</span>
              <span className="panel-dim">{data.context.used.toLocaleString('ru-RU')}</span>
            </div>
            <ul className="panel-breakdown">
              {data.context.categories.map((category) => (
                <li key={category.name}>
                  <span>{category.name}</span>
                  <span className="panel-dim">{category.tokens.toLocaleString('ru-RU')}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Empty started={started} />
        )}
      </Section>

      <Section title="Расход">
        {data.cost ? (
          <div className="panel-line" data-testid="panel-cost">
            <span>за сессию</span>
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
        {data.models.length > 0 ? (
          <select
            className="panel-mode"
            data-testid="panel-model"
            value={data.model ?? ''}
            onChange={(e) => onSetModel(e.target.value)}
          >
            {data.model && !data.models.some((m) => m.value === data.model) && (
              <option value={data.model}>{data.model}</option>
            )}
            {data.models.map((model) => (
              <option key={model.value} value={model.value} title={model.description}>
                {model.displayName}
              </option>
            ))}
          </select>
        ) : data.model ? (
          <div className="panel-line" data-testid="panel-model">
            <span>{data.model}</span>
          </div>
        ) : (
          <Empty started={started} />
        )}
      </Section>

      <Section title="Усилие">
        {started ? (
          <select
            className="panel-mode"
            data-testid="panel-effort"
            value={data.effort ?? ''}
            onChange={(e) => onSetEffort(e.target.value as EffortLevel)}
          >
            {data.effort === null && <option value="">как у модели</option>}
            {efforts.map((level) => (
              <option key={level} value={level}>
                {EFFORT_LABEL[level] ?? level}
              </option>
            ))}
          </select>
        ) : (
          <Empty started={started} />
        )}
      </Section>

      <Section title="Разрешения">
        <select
          className="panel-mode"
          data-testid="panel-mode"
          value={data.permissionMode}
          onChange={(e) => onSetMode(e.target.value as PermissionMode)}
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABEL[mode] ?? mode}
            </option>
          ))}
        </select>
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
          <Empty started={started} text="серверов нет" />
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
      {text ?? (started ? 'появится после первого ответа' : 'появится после запуска')}
    </div>
  )
}

function Bar({ percent }: { percent: number }): JSX.Element {
  const level = percent > 85 ? 'is-high' : percent > 60 ? 'is-mid' : 'is-low'
  return (
    <div className={`panel-bar ${level}`}>
      <div style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
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
        <span>{until(window.resetsAt)}</span>
      </div>
    </div>
  )
}
