import type { BackgroundTask } from '../../shared/types'

/** The status line lists this many; older ones fall off the end. */
const MAX_TASKS = 20
/** Bash calls whose command is kept until their task_started comes. */
const MAX_COMMANDS = 200

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** task_notification's and task_updated's words for an end, in ours. */
function endStatus(status: unknown): BackgroundTask['status'] | null {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'stopped':
    case 'killed':
      return 'stopped'
    default:
      return null
  }
}

/**
 * The tab's background tasks, from the SDK's task events (sdk.d.ts):
 * `task_started`, `task_updated`, `task_notification` and
 * `background_tasks_changed`.
 *
 * Subagents (`local_agent`) are left out — they have their own cards — and
 * so is whatever the SDK marks as not activity (`ambient`, `skip_transcript`).
 * A shell the SDK registered in the foreground (`is_backgrounded: false`)
 * blocks its own tool call and is not listed unless it is later moved to the
 * background (ruling C15).
 */
export class BackgroundTracker {
  private list: BackgroundTask[] = []
  /** Bash tool calls seen so far: their id to their command. */
  private readonly commands = new Map<string, string>()
  /** Foreground tasks that may still be moved to the background. */
  private readonly foreground = new Map<string, BackgroundTask>()
  /**
   * Tasks taken for completed only because they left
   * background_tasks_changed: a later event may still say otherwise.
   */
  private readonly guessed = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  get tasks(): BackgroundTask[] {
    return this.list
  }

  /** The new list when this message changed it, null when it did not. */
  apply(message: unknown): BackgroundTask[] | null {
    if (!isObject(message)) return null
    if (message['type'] === 'assistant') {
      this.rememberCommands(message)
      return null
    }
    if (message['type'] !== 'system') return null
    switch (message['subtype']) {
      case 'task_started':
        return this.onStarted(message)
      case 'task_updated':
        return this.onUpdated(message)
      case 'task_notification':
        return this.onEnded(str(message['task_id']), endStatus(message['status']))
      case 'background_tasks_changed':
        return this.onChanged(message)
      default:
        return null
    }
  }

  private rememberCommands(message: Record<string, unknown>): void {
    const inner = message['message']
    const content = isObject(inner) ? inner['content'] : null
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!isObject(block) || block['type'] !== 'tool_use' || block['name'] !== 'Bash') continue
      const input = block['input']
      const command = isObject(input) ? str(input['command']) : ''
      const id = str(block['id'])
      if (!id || !command) continue
      this.commands.set(id, command)
      // Most calls never become a task; the oldest are forgotten.
      if (this.commands.size > MAX_COMMANDS) {
        const oldest = this.commands.keys().next().value
        if (oldest !== undefined) this.commands.delete(oldest)
      }
    }
  }

  private onStarted(m: Record<string, unknown>): BackgroundTask[] | null {
    const taskId = str(m['task_id'])
    if (!taskId || m['ambient'] === true || m['skip_transcript'] === true) return null
    const type = str(m['task_type'])
    if (type === 'local_agent') return null
    if (this.list.some((t) => t.taskId === taskId)) return null

    const toolUseId = str(m['tool_use_id'])
    const command = toolUseId ? this.commands.get(toolUseId) : undefined
    if (toolUseId) this.commands.delete(toolUseId)
    const task: BackgroundTask = {
      taskId,
      ...(toolUseId ? { toolUseId } : {}),
      type,
      description: str(m['description']),
      ...(command ? { command } : {}),
      status: 'running',
      startedAt: this.now()
    }
    if (m['is_backgrounded'] === false) {
      this.foreground.set(taskId, task)
      return null
    }
    return this.add(task)
  }

  private onUpdated(m: Record<string, unknown>): BackgroundTask[] | null {
    const taskId = str(m['task_id'])
    const patch = m['patch']
    if (!taskId || !isObject(patch)) return null

    const waiting = this.foreground.get(taskId)
    const moved = waiting !== undefined && patch['is_backgrounded'] === true
    if (moved) {
      this.foreground.delete(taskId)
      this.add(waiting)
    }

    const ended = endStatus(patch['status'])
    if (ended) return this.onEnded(taskId, ended) ?? (moved ? this.copy() : null)
    // A task taken for finished is still running after all.
    if (patch['status'] === 'running' && this.guessed.delete(taskId)) {
      return this.replace(taskId, (t) => {
        const { endedAt: _gone, ...rest } = t
        return { ...rest, status: 'running' }
      })
    }
    return moved ? this.copy() : null
  }

  private onEnded(taskId: string, status: BackgroundTask['status'] | null): BackgroundTask[] | null {
    if (!taskId || !status) return null
    // A foreground shell ended where it started: it never was a background one.
    if (this.foreground.delete(taskId)) return null
    const task = this.list.find((t) => t.taskId === taskId)
    if (!task) return null
    const wasGuess = this.guessed.delete(taskId)
    // An end already told is not told again; a guessed one may be corrected.
    if (task.status !== 'running' && !wasGuess) return null
    if (task.status === status) return null
    return this.replace(taskId, (t) => ({
      ...t,
      status,
      // A guessed end keeps its time: the task left the live list then.
      endedAt: wasGuess && t.endedAt !== undefined ? t.endedAt : this.now()
    }))
  }

  /** REPLACE semantics: a running task missing from the payload has ended. */
  private onChanged(m: Record<string, unknown>): BackgroundTask[] | null {
    const live = new Set(
      (Array.isArray(m['tasks']) ? m['tasks'] : []).flatMap((t) =>
        isObject(t) && typeof t['task_id'] === 'string' ? [t['task_id']] : []
      )
    )
    const gone = this.list.filter((t) => t.status === 'running' && !live.has(t.taskId))
    if (gone.length === 0) return null
    const at = this.now()
    for (const t of gone) this.guessed.add(t.taskId)
    this.list = this.list.map((t) =>
      gone.includes(t) ? { ...t, status: 'completed' as const, endedAt: at } : t
    )
    return this.copy()
  }

  private add(task: BackgroundTask): BackgroundTask[] {
    this.list = [task, ...this.list].slice(0, MAX_TASKS)
    return this.copy()
  }

  private replace(
    taskId: string,
    change: (task: BackgroundTask) => BackgroundTask
  ): BackgroundTask[] {
    this.list = this.list.map((t) => (t.taskId === taskId ? change(t) : t))
    return this.copy()
  }

  private copy(): BackgroundTask[] {
    return [...this.list]
  }
}
