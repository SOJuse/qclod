import { useEffect, useState, type ReactNode } from 'react'
import { Cpu, Gauge, RotateCcw, ShieldCheck, Smartphone } from 'lucide-react'
import { LEVEL_LABEL, LevelIcon } from '../ui/icons'
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type EffortLevel,
  type LimitWindow,
  type PanelData,
  type PermissionMode,
  type RemoteInfo
} from '../../shared/types'
import { REMOTE_BLOCK_TEXT, REMOTE_STATE_LABEL, isRemoteLive } from '../../shared/remote'
import { clockTime, untilReset } from '../../shared/format'
import { contextLevel } from '../chat/contextLevel'
import { EFFORT_LABEL, EFFORT_SHORT, MODE_LABEL } from '../labels'
import { Dropdown, type DropdownOption } from './Dropdown'
import { BackgroundTasks } from './BackgroundTasks'
import '../ui/meter.css'
import './StatusLine.css'

interface Props {
  tabId: string
  data: PanelData
  started: boolean
  /** Room for another indicator beside the limits; background tasks have their own place after them. */
  slot?: ReactNode
  /** Remote Control of this tab, and its switch. */
  remote: RemoteInfo
  onToggleRemote: () => void
}

const MODE_NOTE: Partial<Record<PermissionMode, string>> = {
  default: 'спрашивает про каждое действие',
  acceptEdits: 'правки файлов без вопросов, команды — спросит',
  plan: 'только читает и предлагает план',
  autoAllow: 'агент спрашивает — Qclod сам жмёт «разрешить»',
  auto: 'решает модель-классификатор; если не уверена — спросит',
  dontAsk: 'запрещает всё, что не разрешено заранее',
  bypassPermissions: 'спросит подтверждение — выключает все проверки'
}

const MODE_OPTIONS: DropdownOption[] = PERMISSION_MODES.map((mode) => ({
  value: mode,
  label: MODE_LABEL[mode] ?? mode,
  ...(MODE_NOTE[mode] ? { secondary: MODE_NOTE[mode] } : {})
}))

const tokens = (n: number): string => n.toLocaleString('ru-RU')

/**
 * The line right under the input: how the agent works on the left, how much
 * room is left on the right. Everything here used to live in the side panel,
 * which a narrow window hides — and context is the one number worth watching
 * while typing.
 */
export function StatusLine({ tabId, data, started, slot, remote, onToggleRemote }: Props): JSX.Element {
  // Effort is a property of the chosen model: Opus offers more levels than Sonnet.
  const chosen = data.models.find((m) => m.value === data.model)
  const levels = chosen?.supportedEffortLevels ?? EFFORT_LEVELS

  const modelOptions: DropdownOption[] = data.models.map((m) => ({
    value: m.value,
    label: m.displayName,
    ...(m.description ? { secondary: m.description } : {})
  }))
  // A model the session runs on but does not list still has to show as chosen.
  if (data.model && !chosen && modelOptions.length > 0) {
    modelOptions.unshift({ value: data.model, label: data.model })
  }

  const effortOptions: DropdownOption[] = started
    ? levels.map((level) => ({
        value: level,
        label: EFFORT_LABEL[level] ?? level,
        short: EFFORT_SHORT[level] ?? level,
        hint: level
      }))
    : []

  // A level the new model does not offer is not what it runs at: it falls
  // back to the model's own, and the button says so instead of the old code.
  const effortTitle = !data.effort
    ? 'Усилие — как у модели'
    : (levels as readonly string[]).includes(data.effort)
      ? `Усилие: ${EFFORT_LABEL[data.effort] ?? data.effort}`
      : `Усилие — как у модели: «${EFFORT_LABEL[data.effort] ?? data.effort}» у неё нет`

  const waitingFor = started ? 'после первого ответа' : 'после запуска'
  const context = data.context
  const contextTitle = context
    ? `Контекст: ${tokens(context.used)} из ${tokens(context.max)} токенов${
        context.estimated ? ' — оценка по записи разговора' : ''
      }`
    : `Контекст появится ${waitingFor}`

  return (
    <div className="status-line" data-testid="status-line">
      <div className="status-group">
        <Dropdown
          testId="status-mode"
          label="Режим разрешений"
          title={`Режим разрешений: ${MODE_LABEL[data.permissionMode] ?? data.permissionMode} — Shift+Tab по кругу`}
          icon={<ShieldCheck size={13} aria-hidden="true" />}
          value={data.permissionMode}
          options={MODE_OPTIONS}
          onChange={(mode) => void window.qclod.setPermissionMode(tabId, mode as PermissionMode)}
        />
        <Dropdown
          testId="status-model"
          label="Модель"
          title={chosen ? `Модель: ${chosen.displayName}` : 'Модель'}
          icon={<Cpu size={13} aria-hidden="true" />}
          value={data.model}
          placeholder={started ? '…' : 'модель'}
          options={modelOptions}
          onChange={(model) => void window.qclod.setModel(tabId, model)}
        />
        <Dropdown
          testId="status-effort"
          label="Усилие"
          title={effortTitle}
          icon={<Gauge size={13} aria-hidden="true" />}
          value={data.effort}
          placeholder={started ? 'как у модели' : 'усилие'}
          options={effortOptions}
          onChange={(level) => void window.qclod.setEffort(tabId, level as EffortLevel)}
        />
        <RemoteToggle remote={remote} onToggle={onToggleRemote} />
      </div>

      <div className="status-group status-meters">
        <Meter
          testId="status-context"
          label="контекст"
          primary
          percent={context ? context.percent : null}
          approximate={context?.estimated === true}
          title={contextTitle}
        />
        {/* The plan's limits are secondary: smaller, set apart by a hairline. */}
        <span className="status-limits">
          <LimitMeter testId="status-limit-5h" label="5 ч" name="Лимит на 5 часов" window={data.limits.fiveHour} waitingFor={waitingFor} showReset />
          <LimitMeter testId="status-limit-7d" label="нед" name="Лимит на неделю" window={data.limits.sevenDay} waitingFor={waitingFor} />
          {slot}
        </span>
        <BackgroundTasks tabId={tabId} tasks={data.backgroundTasks} />
      </div>
    </div>
  )
}

/**
 * The Remote Control switch. Off it is only an icon with its hint; on, the
 * icon takes the state's colour and the state's word stands beside it.
 */
function RemoteToggle({ remote, onToggle }: { remote: RemoteInfo; onToggle: () => void }): JSX.Element {
  const off = remote.state === 'off'
  const word = REMOTE_STATE_LABEL[remote.state]
  const title = remote.blocked
    ? REMOTE_BLOCK_TEXT[remote.blocked]
    : off
      ? 'Remote Control: продолжить эту сессию с телефона или claude.ai'
      : `Remote Control: ${word}`
  return (
    <button
      type="button"
      className="status-remote"
      data-testid="remote-toggle"
      data-state={remote.state}
      aria-label={off ? 'Remote Control' : `Remote Control: ${word}`}
      aria-pressed={isRemoteLive(remote)}
      title={title}
      disabled={remote.blocked !== undefined}
      onClick={onToggle}
    >
      <Smartphone size={13} aria-hidden="true" />
      {!off && <span>{word}</span>}
    </button>
  )
}

/** Re-renders every `everyMs`, so «через 5 мин» and a passed reset stay true. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

function LimitMeter({
  testId,
  label,
  name,
  window,
  waitingFor,
  showReset = false
}: {
  testId: string
  label: string
  name: string
  window: LimitWindow | null
  waitingFor: string
  /** The reset's time stands beside the bar, not only in its hint. */
  showReset?: boolean
}): JSX.Element {
  const now = useNow(30_000)
  // A window whose reset has passed is spent no more: it reads 0% until the
  // next refresh brings the new one, rather than the old number for hours.
  const reset = window && window.resetsAt > 0 ? window.resetsAt * 1000 : null
  const expired = reset !== null && reset <= now
  const percent = window ? (expired ? 0 : window.utilization * 100) : null
  const title = !window
    ? `${name} — появится ${waitingFor}`
    : expired
      ? `${name}: сброшен в ${clockTime(reset!, now, false)}`
      : `${name}: ${Math.round(window.utilization * 100)}%.` +
        (reset ? ` Сброс в ${clockTime(reset, now, false)} (${untilReset(window.resetsAt, now)})` : '')
  return (
    <Meter
      testId={testId}
      label={label}
      percent={percent}
      title={title}
      suffix={showReset && reset && !expired ? clockTime(reset, now, false) : undefined}
    />
  )
}

/**
 * A short bar and its number (ui/meter.css). The fill stays quiet until 80%,
 * then takes the level's colour and an alert icon joins it — colour is never
 * the only sign. The number keeps a text colour throughout.
 */
function Meter({
  testId,
  label,
  percent,
  approximate = false,
  primary = false,
  title,
  suffix
}: {
  testId: string
  label: string
  percent: number | null
  approximate?: boolean
  /** The context meter: larger than the limits, the line's main number. */
  primary?: boolean
  title: string
  /** A short note after the number: when the window resets. */
  suffix?: string | undefined
}): JSX.Element {
  // The level follows the whole percent shown, so «90%» is always critical.
  // Nothing is ever fuller than full: a count past the window reads 100%.
  const shown = percent === null ? null : Math.min(100, Math.max(0, Math.round(percent)))
  const level = shown === null ? 'ok' : contextLevel(shown)
  return (
    <span
      className={`status-meter is-${level}${primary ? ' is-primary' : ''}`}
      data-testid={testId}
      title={title}
    >
      <span className="status-meter-name">{label}</span>
      <span
        className="meter status-meter-bar"
        data-level={level}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown ?? undefined}
      >
        <span
          className="meter-fill"
          style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
        />
      </span>
      <span className="meter-label status-meter-value">
        {shown === null ? '—' : `${approximate ? '≈' : ''}${shown}%`}
      </span>
      {suffix && (
        <span className="status-meter-reset" data-testid={`${testId}-reset`}>
          <RotateCcw size={10} aria-hidden="true" />
          {suffix}
        </span>
      )}
      {level !== 'ok' && (
        <span className="status-meter-alert" data-testid={`${testId}-alert`}>
          <LevelIcon level={level} label={LEVEL_LABEL[primary ? 'context' : 'limit'][level]} size={12} />
        </span>
      )}
    </span>
  )
}
