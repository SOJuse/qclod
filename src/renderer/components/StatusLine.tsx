import type { ReactNode } from 'react'
import { CircleAlert, Cpu, Gauge, ShieldCheck } from 'lucide-react'
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type EffortLevel,
  type LimitWindow,
  type PanelData,
  type PermissionMode
} from '../../shared/types'
import { untilReset } from '../../shared/format'
import { contextLevel } from '../chat/contextLevel'
import { EFFORT_LABEL, EFFORT_SHORT, MODE_LABEL } from '../labels'
import { Dropdown, type DropdownOption } from './Dropdown'
import './StatusLine.css'

interface Props {
  tabId: string
  data: PanelData
  started: boolean
  /** Room on the right for what a later part adds (background tasks). */
  slot?: ReactNode
}

const MODE_NOTE: Partial<Record<PermissionMode, string>> = {
  plan: 'только читает и предлагает план',
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
export function StatusLine({ tabId, data, started, slot }: Props): JSX.Element {
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
          title="Режим разрешений — Shift+Tab по кругу"
          icon={<ShieldCheck size={13} aria-hidden="true" className="status-icon" />}
          value={data.permissionMode}
          options={MODE_OPTIONS}
          onChange={(mode) => void window.qclod.setPermissionMode(tabId, mode as PermissionMode)}
        />
        <Dropdown
          testId="status-model"
          label="Модель"
          title={chosen ? `Модель: ${chosen.displayName}` : 'Модель'}
          icon={<Cpu size={13} aria-hidden="true" className="status-icon" />}
          value={data.model}
          placeholder={started ? '…' : 'модель'}
          options={modelOptions}
          onChange={(model) => void window.qclod.setModel(tabId, model)}
        />
        <Dropdown
          testId="status-effort"
          label="Усилие"
          title={data.effort ? `Усилие: ${EFFORT_LABEL[data.effort] ?? data.effort}` : 'Усилие — как у модели'}
          icon={<Gauge size={13} aria-hidden="true" className="status-icon" />}
          value={data.effort}
          placeholder={started ? 'как у модели' : 'усилие'}
          options={effortOptions}
          onChange={(level) => void window.qclod.setEffort(tabId, level as EffortLevel)}
        />
      </div>

      <div className="status-group status-meters">
        <Meter
          testId="status-context"
          label="контекст"
          percent={context ? context.percent : null}
          approximate={context?.estimated === true}
          title={contextTitle}
        />
        <LimitMeter testId="status-limit-5h" label="5 ч" name="Лимит на 5 часов" window={data.limits.fiveHour} waitingFor={waitingFor} />
        <LimitMeter testId="status-limit-7d" label="нед" name="Лимит на неделю" window={data.limits.sevenDay} waitingFor={waitingFor} />
        {slot}
      </div>
    </div>
  )
}

function LimitMeter({
  testId,
  label,
  name,
  window,
  waitingFor
}: {
  testId: string
  label: string
  name: string
  window: LimitWindow | null
  waitingFor: string
}): JSX.Element {
  const percent = window ? window.utilization * 100 : null
  const title = window
    ? `${name}: ${Math.round(window.utilization * 100)}%. Сброс ${untilReset(window.resetsAt)}`
    : `${name} — появится ${waitingFor}`
  return <Meter testId={testId} label={label} percent={percent} title={title} />
}

/**
 * A short bar and its number. The fill takes the level's colour and, past
 * 80%, an alert icon joins it — colour is never the only sign. The number
 * keeps the text colour.
 */
function Meter({
  testId,
  label,
  percent,
  approximate = false,
  title
}: {
  testId: string
  label: string
  percent: number | null
  approximate?: boolean
  title: string
}): JSX.Element {
  const level = percent === null ? 'ok' : contextLevel(percent)
  const shown = percent === null ? null : Math.round(percent)
  return (
    <span className={`status-meter is-${level}`} data-testid={testId} title={title}>
      <span className="status-meter-label">{label}</span>
      <span
        className="status-meter-bar"
        data-level={level}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={shown ?? undefined}
      >
        <span
          className="status-meter-fill"
          style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
        />
      </span>
      <span className="status-meter-value">
        {shown === null ? '—' : `${approximate ? '≈' : ''}${shown}%`}
      </span>
      {level !== 'ok' && (
        <CircleAlert size={12} aria-hidden="true" className="status-meter-alert" data-testid={`${testId}-alert`} />
      )}
    </span>
  )
}
