import { useEffect, useState, type ReactNode } from 'react'
import { Cpu, Gauge, ShieldCheck, Smartphone } from 'lucide-react'
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
import { untilReset } from '../../shared/format'
import { contextLevel } from '../chat/contextLevel'
import { EFFORT_LABEL, EFFORT_SHORT, MODE_LABEL } from '../labels'
import { Dropdown, type DropdownOption } from './Dropdown'
import { BackgroundTasks } from './BackgroundTasks'
import { cardForTask } from '../agents/cardForTask'
import { useAppStore } from '../state/useAppStore'
import '../ui/meter.css'
import './StatusLine.css'

interface Props {
  tabId: string
  data: PanelData
  started: boolean
  /** Room for another indicator beside the limit alert; background tasks have their own place after them. */
  slot?: ReactNode
  /** Remote Control of this tab, and its switch. */
  remote: RemoteInfo
  onToggleRemote: () => void
}

const MODE_NOTE: Partial<Record<PermissionMode, string>> = {
  default: 'спрашивает про каждое действие',
  acceptEdits: 'правки файлов без вопросов, команды — спросит',
  plan: 'только читает и предлагает план',
  autoAllow: 'спросит подтверждение — дальше Qclod сам жмёт «разрешить»',
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

/** From this share of a plan window on, the line shows it as an alert chip; below it the panel holds it. */
export const LIMIT_ALERT = 0.8

/** One plan window as the line words it: the chip's short name and the hint's full one. */
const LIMIT_NAMES = {
  fiveHour: { short: '5 ч', full: 'Лимит на 5 часов' },
  sevenDay: { short: 'Неделя', full: 'Лимит на неделю' }
} as const
type LimitKey = keyof typeof LIMIT_NAMES
const LIMIT_KEYS: readonly LimitKey[] = ['fiveHour', 'sevenDay']

/** A window still counting. One whose reset has passed is spent no more: nothing until the next refresh. */
function liveShare(window: LimitWindow | null, now: number): number | null {
  if (!window) return null
  if (window.resetsAt > 0 && window.resetsAt * 1000 <= now) return null
  return window.utilization
}

/** «Лимит на 5 часов: 85 %, сброс через 2 ч 0 мин». */
function limitTitle(key: LimitKey, window: LimitWindow, now: number): string {
  const percent = Math.round(window.utilization * 100)
  const reset = window.resetsAt > 0 ? `, сброс ${untilReset(window.resetsAt, now)}` : ''
  return `${LIMIT_NAMES[key].full}: ${percent} %${reset}`
}

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
  // Below 80 % the limits leave the line, but not its hints: a pane whose panel is
  // closed (a split, a narrow window) still has them under the context meter.
  const now = useNow(30_000)
  const limitLines = LIMIT_KEYS.flatMap((key) => {
    const window = data.limits[key]
    return window && liveShare(window, now) !== null ? [limitTitle(key, window, now)] : []
  })

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
          title={[contextTitle, ...limitLines].join('\n')}
        />
        <LimitAlert limits={data.limits} now={now} />
        {slot}
        <BackgroundTasks
          tabId={tabId}
          tasks={data.backgroundTasks}
          // An agent's row opens its own ribbon in this pane's agents layer (этап 4).
          onOpenAgent={(taskId) => {
            const state = useAppStore.getState()
            state.openAgents(tabId, cardForTask(state.ribbonByTab[tabId] ?? [], taskId))
          }}
        />
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

/**
 * A plan window at 80 % or more, as one quiet chip: «5 ч: 85 %» or «Неделя: 91 %»;
 * both that full — the fuller one. The hint says when it resets; the panel has the rest.
 * No narrow-line rule hides it: when the pane's panel is closed it is the only sign.
 */
function LimitAlert({ limits, now }: { limits: PanelData['limits']; now: number }): JSX.Element | null {
  let worst: { key: LimitKey; window: LimitWindow; share: number } | null = null
  for (const key of LIMIT_KEYS) {
    const window = limits[key]
    const share = liveShare(window, now)
    if (window && share !== null && share >= LIMIT_ALERT && (!worst || share > worst.share)) {
      worst = { key, window, share }
    }
  }
  if (!worst) return null
  const percent = Math.min(100, Math.round(worst.share * 100))
  // 80 % and up is never `ok`; the level picks the icon and its colour.
  const level = contextLevel(percent) === 'critical' ? 'critical' : 'warn'
  return (
    <span
      className={`status-limit-alert is-${level}`}
      data-testid="status-limit-alert"
      data-limit={worst.key}
      title={limitTitle(worst.key, worst.window, now)}
    >
      <LevelIcon level={level} label={LEVEL_LABEL.limit[level]} size={12} />
      <span className="status-limit-text">
        {`${LIMIT_NAMES[worst.key].short}: ${percent} %`}
      </span>
    </span>
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
  title
}: {
  testId: string
  label: string
  percent: number | null
  approximate?: boolean
  /** The context meter: the line's main number. */
  primary?: boolean
  title: string
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
      {level !== 'ok' && (
        <span className="status-meter-alert" data-testid={`${testId}-alert`}>
          <LevelIcon level={level} label={LEVEL_LABEL[primary ? 'context' : 'limit'][level]} size={12} />
        </span>
      )}
    </span>
  )
}
