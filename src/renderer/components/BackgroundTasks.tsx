import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronRight, ChevronUp, CircleAlert, CircleCheck, CircleDot, CircleSlash, CircleStop, CircleX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { BackgroundTask, TabId, TaskOutput } from '../../shared/types'
import { plural } from '../../shared/format'
import { remoteErrorText, stripAnsi } from '../chat/stripAnsi'
import { CategoryIcon } from '../ui/icons'
import { AGENT_STATE_LABEL } from './agentState'
import './BackgroundTasks.css'

interface Props {
  tabId: TabId
  tasks: BackgroundTask[]
  /** Opens an agent's own ribbon in the pane's agents layer (этап 4); without it there is no «Открыть ленту». */
  onOpenAgent?: (taskId: string) => void
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

/** An agent's row says what its node in the graph says: «готов», not «готова». */
const AGENT_WORD: Record<BackgroundTask['status'], string> = {
  running: AGENT_STATE_LABEL.running,
  completed: AGENT_STATE_LABEL.done,
  failed: AGENT_STATE_LABEL.failed,
  stopped: AGENT_STATE_LABEL.stopped,
  interrupted: AGENT_STATE_LABEL.unfinished
}

/** 0:07, 2:05, 61:40 — how long a task has run. */
function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function counterTitle(running: number, total: number): string {
  if (running === 0) return `Фоновые задачи: ${total}, все закончились`
  return `Фоновые задачи: ${running} ${plural(running, 'работает', 'работают', 'работают')}`
}

/**
 * The task manager of this tab (F7), on the right of the status line: how
 * many background tasks are running, and a list opening upward — the
 * background agents, then the commands, each with its time and outcome. An
 * agent's row opens its own ribbon; a command's shows the end of its output.
 */
export function BackgroundTasks({ tabId, tasks, onOpenAgent }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false)
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

  // An open list whose tasks all went says so; a closed one leaves no counter.
  if (tasks.length === 0 && !open) return null

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
        <TaskManagerList
          tabId={tabId}
          tasks={tasks}
          {...(onOpenAgent
            ? {
                onOpenAgent: (taskId: string) => {
                  setOpen(false)
                  onOpenAgent(taskId)
                }
              }
            : {})}
        />
      )}
    </span>
  )
}

/**
 * The list itself: agents and commands in groups of their own (an empty one
 * is not drawn), and «Остановить все» once two or more are running — each
 * task simply stops, so there is nothing to confirm.
 */
export function TaskManagerList({ tabId, tasks, onOpenAgent }: Props): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const agents = tasks.filter((t) => t.kind === 'agent')
  const commands = tasks.filter((t) => t.kind !== 'agent')
  const running = tasks.filter((t) => t.status === 'running')

  const stopAll = (): void => {
    // Each row's own stop says why, if one refuses; here nothing is held up by it.
    for (const task of running) void window.qclod.stopTask(tabId, task.taskId).catch(() => undefined)
  }

  return (
    <div className="bg-list" data-testid="bg-list" role="dialog" aria-label="Диспетчер задач">
      <div className="bg-list-head">
        <span className="bg-list-title">Диспетчер задач</span>
        {running.length >= 2 && (
          <button type="button" className="bg-stop" data-testid="bg-stop-all" title="Остановить все работающие задачи" onClick={stopAll}>
            Остановить все
          </button>
        )}
      </div>
      {tasks.length === 0 ? (
        <div className="bg-empty" data-testid="bg-empty">
          Фоновых задач нет
        </div>
      ) : (
        <div className="bg-rows">
          {agents.length > 0 && (
            <section className="bg-group" aria-label="Агенты">
              <div className="bg-group-title">Агенты</div>
              <ul className="bg-group-rows">
                {agents.map((task) => (
                  <AgentRow key={task.taskId} tabId={tabId} task={task} {...(onOpenAgent ? { onOpenAgent } : {})} />
                ))}
              </ul>
            </section>
          )}
          {commands.length > 0 && (
            <section className="bg-group" aria-label="Команды">
              <div className="bg-group-title">Команды</div>
              <ul className="bg-group-rows">
                {commands.map((task) => (
                  <TaskRow
                    key={task.taskId}
                    tabId={tabId}
                    task={task}
                    expanded={expanded === task.taskId}
                    onToggle={() => setExpanded((id) => (id === task.taskId ? null : task.taskId))}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/** Stops one task; a refusal is said in its row, with the reason. Its end clears both. */
function useStop(tabId: TabId, task: BackgroundTask): { stopping: boolean; stopError: string | null; stop: () => void } {
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const running = task.status === 'running'

  useEffect(() => {
    if (!running) {
      setStopping(false)
      setStopError(null)
    }
  }, [running])

  const stop = (): void => {
    setStopping(true)
    setStopError(null)
    // On success the button stays disabled: the task's notification ends it.
    window.qclod.stopTask(tabId, task.taskId).catch((err: unknown) => {
      setStopping(false)
      setStopError(remoteErrorText(err))
    })
  }
  return { stopping, stopError, stop }
}

function StopButton({ stopping, onStop }: { stopping: boolean; onStop: () => void }): JSX.Element {
  return (
    <button type="button" className="bg-stop" data-testid="bg-stop" title="Остановить эту задачу" disabled={stopping} onClick={onStop}>
      {stopping ? 'Останавливаю…' : 'Остановить'}
    </button>
  )
}

function StopError({ text }: { text: string | null }): JSX.Element | null {
  if (text === null) return null
  return (
    <div className="bg-task-error" data-testid="bg-stop-error" role="alert">
      <CircleAlert size={12} color="var(--status-critical)" aria-hidden="true" />
      <span>Не удалось остановить: {text}</span>
    </div>
  )
}

/**
 * A background agent: its kind, what it was asked, what it says it is doing,
 * time and state. It has no output to read (taskOutput refuses non-shell
 * tasks); its own ribbon is a button away.
 */
function AgentRow({
  tabId,
  task,
  onOpenAgent
}: {
  tabId: TabId
  task: BackgroundTask
  onOpenAgent?: (taskId: string) => void
}): JSX.Element {
  const { stopping, stopError, stop } = useStop(tabId, task)
  const status = STATUS[task.status]
  const StatusIcon = status.icon
  const running = task.status === 'running'
  return (
    <li className={`bg-task is-agent is-${task.status}`} data-testid="bg-task" data-kind="agent" data-status={task.status}>
      <div className="bg-task-head">
        <span className="bg-agent-what">
          <CategoryIcon category="agent" size={13} />
          <span className="bg-agent-type">{task.subagentType || 'агент'}</span>
          <span className="bg-task-label" title={task.description}>
            {task.description}
          </span>
        </span>
        <span className="bg-task-time" title={task.endedAt ? 'Сколько работал' : 'Работает уже'}>
          {clock((task.endedAt ?? Date.now()) - task.startedAt)}
        </span>
        <span className="bg-task-status">
          <StatusIcon size={12} color={status.color} aria-hidden="true" />
          {AGENT_WORD[task.status]}
        </span>
      </div>
      {(task.summary || onOpenAgent || running) && (
        <div className="bg-agent-foot">
          <span className="bg-agent-summary" title={task.summary}>
            {task.summary}
          </span>
          {onOpenAgent && (
            <button
              type="button"
              className="bg-open"
              data-testid="bg-open-agent"
              title="Открыть ленту этого агента в слое «Агенты»"
              onClick={() => onOpenAgent(task.taskId)}
            >
              Открыть ленту
            </button>
          )}
          {running && <StopButton stopping={stopping} onStop={stop} />}
        </div>
      )}
      <StopError text={stopError} />
    </li>
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
  const { stopping, stopError, stop } = useStop(tabId, task)
  const status = STATUS[task.status]
  const StatusIcon = status.icon
  const elapsed = (task.endedAt ?? Date.now()) - task.startedAt
  const label = task.command ?? task.description
  const outputId = `bg-output-${task.taskId}`
  const running = task.status === 'running'

  return (
    <li className={`bg-task is-${task.status}`} data-testid="bg-task" data-kind="command" data-status={task.status}>
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
        {running && <StopButton stopping={stopping} onStop={stop} />}
      </div>
      <StopError text={stopError} />
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
