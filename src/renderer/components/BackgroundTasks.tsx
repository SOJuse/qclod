import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronUp, CircleAlert, CircleCheck, CircleDot, CircleSlash, CircleStop, CircleX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { BackgroundTask, TabId, TaskOutput } from '../../shared/types'
import { plural } from '../../shared/format'
import { remoteErrorText, stripAnsi } from '../chat/stripAnsi'
import { CategoryIcon } from '../ui/icons'
import './BackgroundTasks.css'

interface Props {
  tabId: TabId
  tasks: BackgroundTask[]
}

/** The pause between one read of an opened, running task's output and the next. */
const POLL_MS = 1000

export const OUTPUT_UNAVAILABLE = 'Вывод недоступен в этой версии Claude Code'

const STATUS: Record<BackgroundTask['status'], { word: string; icon: LucideIcon; color: string }> = {
  running: { word: 'работает', icon: CircleDot, color: 'var(--cat-command)' },
  completed: { word: 'готова', icon: CircleCheck, color: 'var(--status-ok)' },
  failed: { word: 'ошибка', icon: CircleX, color: 'var(--status-critical)' },
  stopped: { word: 'остановлена', icon: CircleStop, color: 'var(--text-faint)' },
  interrupted: { word: 'прервана', icon: CircleSlash, color: 'var(--status-warn)' }
}

/** 0:07, 2:05, 61:40 — how long a task has run. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function counterTitle(running: number, total: number): string {
  if (running === 0) return `Фоновые команды: ${total}, все закончились`
  return `Фоновые команды: ${running} ${plural(running, 'работает', 'работают', 'работают')}`
}

/**
 * The background commands of this tab, on the right of the status line:
 * how many are running, and a list opening upward with each one's command,
 * time, outcome and the end of its output. Subagents are not here — they
 * have their own cards in the ribbon.
 */
export function BackgroundTasks({ tabId, tasks }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const self = useRef<HTMLSpanElement | null>(null)
  const running = tasks.filter((t) => t.status === 'running').length

  // Running times tick only while someone can see them.
  useEffect(() => {
    if (!open || running === 0) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [open, running])

  // The list closes on a click anywhere else.
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      if (!self.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  // Esc closes the open list wherever focus is — the input included — and
  // goes no further: closing a list must not stop the agent. Caught on the
  // window before anything else hears it.
  useEffect(() => {
    if (!open) return
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || ev.isComposing) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (tasks.length === 0) return null

  return (
    <span className="bg" ref={self}>
      <button
        type="button"
        className={`bg-counter${open ? ' is-open' : ''}${running > 0 ? ' is-running' : ''}`}
        data-testid="status-bg"
        aria-expanded={open}
        aria-haspopup="true"
        title={counterTitle(running, tasks.length)}
        onClick={() => setOpen((v) => !v)}
      >
        <CategoryIcon category="command" size={13} />
        <span>Фоновые{running > 0 ? ` ${running}` : ''}</span>
        <ChevronUp size={12} aria-hidden="true" className="bg-chevron" />
      </button>

      {open && (
        <div className="bg-list" data-testid="bg-list" role="dialog" aria-label="Фоновые команды">
          <div className="bg-list-title">Фоновые команды</div>
          <ul className="bg-rows">
            {tasks.map((task) => (
              <TaskRow
                key={task.taskId}
                tabId={tabId}
                task={task}
                expanded={expanded === task.taskId}
                onToggle={() => setExpanded((id) => (id === task.taskId ? null : task.taskId))}
              />
            ))}
          </ul>
        </div>
      )}
    </span>
  )
}

function TaskRow({
  tabId,
  task,
  expanded,
  onToggle
}: {
  tabId: TabId
  task: BackgroundTask
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const status = STATUS[task.status]
  const StatusIcon = status.icon
  const elapsed = (task.endedAt ?? Date.now()) - task.startedAt
  const label = task.command ?? task.description
  const outputId = `bg-output-${task.taskId}`
  const running = task.status === 'running'

  // Its end clears what was said about stopping it.
  useEffect(() => {
    if (!running) {
      setStopping(false)
      setStopError(null)
    }
  }, [running])

  const stop = async (): Promise<void> => {
    setStopping(true)
    setStopError(null)
    try {
      // On success the button stays disabled: the task's notification ends it.
      await window.qclod.stopTask(tabId, task.taskId)
    } catch (err) {
      setStopping(false)
      setStopError(remoteErrorText(err))
    }
  }

  return (
    <li className={`bg-task is-${task.status}`} data-testid="bg-task" data-status={task.status}>
      <div className="bg-task-head">
        <button
          type="button"
          className="bg-task-toggle"
          data-testid="bg-task-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? outputId : undefined}
          title={expanded ? 'Скрыть вывод' : 'Показать вывод'}
          onClick={onToggle}
        >
          <ChevronRight size={12} aria-hidden="true" className="bg-task-chevron" />
          <span className={`bg-task-label${task.command ? ' is-mono' : ''}`} title={label}>
            {label}
          </span>
        </button>
        <span className="bg-task-time" title={task.endedAt ? 'Сколько работала' : 'Работает уже'}>
          {clock(elapsed)}
        </span>
        <span className="bg-task-status">
          <StatusIcon size={12} color={status.color} aria-hidden="true" />
          {status.word}
        </span>
        {running && (
          <button
            type="button"
            className="bg-stop"
            data-testid="bg-stop"
            disabled={stopping}
            onClick={() => void stop()}
          >
            {stopping ? 'Останавливаю…' : 'Остановить'}
          </button>
        )}
      </div>
      {stopError !== null && (
        <div className="bg-task-error" data-testid="bg-stop-error" role="alert">
          <CircleAlert size={12} color="var(--status-critical)" aria-hidden="true" />
          <span>Не удалось остановить: {stopError}</span>
        </div>
      )}
      {expanded && <TaskOutputView id={outputId} tabId={tabId} task={task} />}
    </li>
  )
}

type OutputState = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; value: TaskOutput }

/**
 * The end of the command's output, read while the row is open: again a
 * second after each answer while it runs — never two reads at once — and
 * once more when it has ended.
 */
function TaskOutputView({ id, tabId, task }: { id: string; tabId: TabId; task: BackgroundTask }): JSX.Element {
  const [state, setState] = useState<OutputState>({ kind: 'loading' })
  const box = useRef<HTMLPreElement | null>(null)
  const pinned = useRef(true)
  const running = task.status === 'running'

  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = async (): Promise<void> => {
      const out = await window.qclod.taskOutput(tabId, task.taskId).catch(() => null)
      if (!live) return
      setState(
        out === null
          ? { kind: 'unavailable' }
          : { kind: 'ready', value: { ...out, output: stripAnsi(out.output) } }
      )
      if (running) timer = setTimeout(() => void read(), POLL_MS)
    }
    void read()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [tabId, task.taskId, running])

  // New output keeps the view at the bottom, unless the user scrolled up to read.
  const text = state.kind === 'ready' ? state.value.output : ''
  useLayoutEffect(() => {
    const el = box.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [text])

  if (state.kind === 'unavailable') {
    return (
      <div id={id} className="bg-output is-note" data-testid="bg-output">
        {OUTPUT_UNAVAILABLE}
      </div>
    )
  }

  const empty =
    state.kind === 'loading' ? 'Вывод загружается…' : running ? 'Пока ничего не вывела' : 'Ничего не вывела'
  return (
    <div id={id} className="bg-output-wrap">
      {state.kind === 'ready' && state.value.truncated && (
        <div className="bg-output-cut">Показан конец вывода — последние 8 КиБ</div>
      )}
      <pre
        ref={box}
        className={`bg-output${text === '' ? ' is-note' : ''}`}
        data-testid="bg-output"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4
        }}
      >
        {text === '' ? empty : text}
      </pre>
    </div>
  )
}
