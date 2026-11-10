import type { Attachment, RibbonChange, RibbonItem, SubagentState, TodoItem, ToolState } from './types'

/**
 * Turns the SDK's message stream into the ribbon the user reads.
 *
 * Pure: no React, no Electron, no I/O. Everything the user understands about
 * what the agent is doing is decided here, so this is the most heavily tested
 * module in the project.
 *
 * Two rules shape it:
 *
 *  - **One thing the user did is one item.** A tool call and its result are one
 *    card, not two; a stream of text deltas is one paragraph, not twenty.
 *  - **An unknown message is ignored, never fatal.** The SDK's message union
 *    has more than forty members and grows between releases (probe note 8).
 */

interface Clock {
  now?: () => number
}

/** A content block currently being streamed, keyed by its index in the message. */
interface OpenBlock {
  itemId: string
  kind: 'agentText' | 'thinking'
  startedAt: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 1 строка, 3 строки, 10 строк. */
function lines(n: number): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return `${n} строк`
  if (ones === 1) return `${n} строка`
  if (ones >= 2 && ones <= 4) return `${n} строки`
  return `${n} строк`
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : path
}

function clip(text: string, max = 80): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * What the card says the tool is acting on. Deliberately short: the file name,
 * the command, the pattern — the detail lives behind the click.
 */
export function toolTarget(name: string, input: Record<string, unknown>): string {
  const path = str(input['file_path']) || str(input['path']) || str(input['notebook_path'])
  if (path) return basename(path)
  if (name === 'Bash') return clip(str(input['command']))
  const pattern = str(input['pattern'])
  if (pattern) {
    const where = str(input['glob']) || str(input['path'])
    return where ? `${pattern} в ${basename(where)}` : pattern
  }
  return clip(str(input['url']) || str(input['description']) || str(input['prompt']))
}

/** The right-hand side of the card: `Read auth.ts · 120 строк`. */
export function toolSummary(name: string, result: string): string {
  const trimmed = result.trim()
  if (!trimmed) return 'готово'
  if (name === 'Read' || name === 'Grep' || name === 'Glob') {
    return lines(trimmed.split('\n').length)
  }
  if (trimmed.length <= 40 && !trimmed.includes('\n')) return trimmed
  return lines(trimmed.split('\n').length)
}

/** Flattens a tool_result's content, which is a string or a block array. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  return asArray(content)
    .map((block) => (isObject(block) ? str(block['text']) : ''))
    .filter(Boolean)
    .join('\n')
}

/**
 * What a finished subagent cost, from the Task tool's structured output.
 *
 * The shape is the subagent's report plus run totals; field names have moved
 * between CLI versions, so every known spelling is tried and anything missing
 * is simply absent rather than guessed at.
 */
function subagentStats(result: unknown): {
  tokens?: number
  durationMs?: number
  toolCalls?: number
} {
  if (!isObject(result)) return {}
  const usage = isObject(result['usage']) ? result['usage'] : {}
  const totals = isObject(result['totals']) ? result['totals'] : {}

  const num = (...candidates: unknown[]): number | undefined => {
    for (const value of candidates) if (typeof value === 'number' && value > 0) return value
    return undefined
  }

  // AgentOutput (sdk-tools.d.ts) names its totals totalTokens, totalDurationMs
  // and totalToolUseCount; the older spellings stay as fallbacks.
  const tokens = num(
    result['totalTokens'],
    totals['totalTokens'],
    usage['total_tokens'],
    (Number(usage['input_tokens'] ?? 0) || 0) + (Number(usage['output_tokens'] ?? 0) || 0)
  )
  const durationMs = num(result['totalDurationMs'], result['durationMs'], result['duration_ms'], totals['durationMs'])
  const toolCalls = num(result['totalToolUseCount'], result['toolUseCount'], result['tool_use_count'], totals['toolCalls'])

  return {
    ...(tokens ? { tokens } : {}),
    ...(durationMs ? { durationMs } : {}),
    ...(toolCalls ? { toolCalls } : {})
  }
}

/**
 * Everything the CLI injects into a user message that the user never typed.
 *
 * A resumed conversation is full of it: reminders the harness adds, the echo
 * of a slash command, the stdout of a local command. Replaying it verbatim is
 * why reopening an old chat showed a wall of XML nobody wrote.
 */
const INJECTED_TAGS = [
  'system-reminder',
  'command-name',
  'command-message',
  'command-args',
  'local-command-stdout',
  'local-command-stderr',
  'user-prompt-submit-hook',
  'task-notification'
]

const INJECTED = INJECTED_TAGS.map(
  (tag) => new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')
)

/** An opener with no closer: the block was cut off mid-stream. */
const TRUNCATED = new RegExp(`<(${INJECTED_TAGS.join('|')})>`)

/** Strips the injected blocks and returns what the person actually said. */
export function userText(raw: string): string {
  let text = raw
  for (const pattern of INJECTED) text = text.replace(pattern, '')
  // A lone unclosed opener means the block was truncated; drop the remainder.
  const opener = text.search(TRUNCATED)
  if (opener !== -1) text = text.slice(0, opener)
  return text.trim()
}

/** One finished-subagent notice, as the CLI words it for the main agent. */
export interface TaskNotice {
  taskId: string
  toolUseId: string
  status: 'completed' | 'failed' | 'stopped' | 'killed'
  summary: string
  usage?: { tokens: number; toolCalls: number; durationMs: number }
}

function tagValue(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)
  return m ? m[1]!.trim() : undefined
}

/** Every <task-notification> block in the text, wherever it sits (a reminder included). */
export function parseTaskNotifications(text: string): TaskNotice[] {
  const notices: TaskNotice[] = []
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const block = match[1]!
    const taskId = tagValue(block, 'task-id') ?? ''
    const toolUseId = tagValue(block, 'tool-use-id') ?? ''
    if (!taskId && !toolUseId) continue
    const status = tagValue(block, 'status')
    const notice: TaskNotice = {
      taskId,
      toolUseId,
      status: status === 'failed' || status === 'stopped' || status === 'killed' ? status : 'completed',
      summary: tagValue(block, 'summary') ?? ''
    }
    const usage = tagValue(block, 'usage')
    if (usage !== undefined) {
      notice.usage = {
        tokens: Number(tagValue(usage, 'subagent_tokens') ?? 0) || 0,
        toolCalls: Number(tagValue(usage, 'tool_uses') ?? 0) || 0,
        durationMs: Number(tagValue(usage, 'duration_ms') ?? 0) || 0
      }
    }
    notices.push(notice)
  }
  return notices
}

const NOTICE_STATE: Record<TaskNotice['status'], SubagentState> = {
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
  killed: 'stopped'
}

type SubagentItem = Extract<RibbonItem, { kind: 'subagent' }>

function imageAttachment(block: Record<string, unknown>): Attachment | null {
  const source = block['source']
  if (!isObject(source) || source['type'] !== 'base64') return null
  return {
    kind: 'image',
    mediaType: str(source['media_type']) || 'image/png',
    dataBase64: str(source['data'])
  }
}

export class RibbonBuilder {
  private readonly list: RibbonItem[] = []
  private readonly byToolUseId = new Map<string, string>()
  /** task_id of a subagent's task events -> its card, learnt from task_started. */
  private readonly byTaskId = new Map<string, string>()
  /** When each subagent card was placed, for timing it ourselves. */
  private readonly startedAt = new Map<string, number>()
  private readonly openBlocks = new Map<number, OpenBlock>()
  /** Message ids whose text already reached the ribbon as deltas. */
  private readonly streamed = new Set<string>()
  private todoList: TodoItem[] | null = null
  /**
   * Text already shown because the user just typed it. The CLI echoes every
   * message back, and the echo must not become a second copy of it on screen.
   */
  private readonly pendingEchoes: string[] = []
  private seq = 0
  private readonly now: () => number

  constructor(options: Clock = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  get items(): RibbonItem[] {
    return this.list
  }

  get todo(): TodoItem[] | null {
    return this.todoList
  }

  /**
   * The user's own message, when it is not coming back from the SDK as an echo
   * — a replayed history entry arrives as a `user` message instead.
   */
  addUser(text: string, attachments: Attachment[] = [], echoKey = text): RibbonChange[] {
    // What is shown and what will be echoed are not always the same string:
    // an attached file reaches the agent as an @-mention appended to the text.
    this.pendingEchoes.push(echoKey)
    return [this.append({ kind: 'user', id: this.nextId(), text, attachments })]
  }

  /**
   * A permission question, shown where the tool's own card will go (spec 6.4),
   * so the user sees what is about to happen in its place in the story.
   */
  addPermission(requestId: string, toolName: string, target: string): RibbonChange[] {
    return [
      this.append({
        kind: 'permission',
        id: this.nextId(),
        requestId,
        toolName,
        target,
        state: 'pending'
      })
    ]
  }

  /** The agent's plan, waiting to be read and answered (spec 6.4). */
  addPlan(requestId: string, text: string): RibbonChange[] {
    return [this.append({ kind: 'plan', id: this.nextId(), requestId, text, state: 'pending' })]
  }

  resolvePlan(requestId: string, state: 'approved' | 'rejected'): RibbonChange[] {
    const item = this.list.find((i) => i.kind === 'plan' && i.requestId === requestId)
    if (!item || item.kind !== 'plan') return []
    item.state = state
    return [this.update(item.id, { state })]
  }

  resolvePermission(requestId: string, state: 'allowed' | 'denied'): RibbonChange[] {
    const item = this.list.find((i) => i.kind === 'permission' && i.requestId === requestId)
    if (!item || item.kind !== 'permission') return []
    item.state = state
    return [this.update(item.id, { state })]
  }

  /** Whether a card for this tool call is already in the ribbon. */
  hasToolUse(toolUseId: string): boolean {
    return this.byToolUseId.has(toolUseId)
  }

  /** Records the user's answer to a question card. */
  answerQuestion(toolUseId: string, answer: string): RibbonChange[] {
    const item = this.list.find((i) => i.kind === 'question' && i.toolUseId === toolUseId)
    if (!item || item.kind !== 'question') return []
    // Kept on the item itself: a snapshot (reload, split pane, a session
    // taking this ribbon over) is built from the items, not from the events.
    item.answer = answer
    return [this.update(item.id, { answer })]
  }

  /**
   * Settles everything still shown as in progress.
   *
   * Called when the session ends without finishing: streaming text stops
   * blinking and a running tool stops claiming to run.
   */
  closeOpen(): RibbonChange[] {
    const changes = this.closeOpenBlocks()
    for (const item of this.list) {
      if (item.kind === 'tool' && item.state === 'running') {
        item.state = 'done'
        item.summary = 'не закончил'
        changes.push(this.update(item.id, { state: 'done', summary: item.summary }))
      }
      if (item.kind === 'subagent' && item.state === 'running') {
        item.state = 'unfinished'
        item.summary = 'не закончил'
        changes.push(this.update(item.id, { state: 'unfinished', summary: item.summary }))
      }
    }
    return changes
  }

  /**
   * Called once a past conversation has been replayed. Whatever it still shows
   * as running (a tool, a background subagent) was run by a process that
   * closed with the app and will never report back, so it is settled the way
   * closeOpen() settles a session that ended: «не закончил».
   */
  finishReplay(): RibbonChange[] {
    return this.closeOpen()
  }

  apply(message: unknown): RibbonChange[] {
    if (!isObject(message)) return []
    switch (message['type']) {
      case 'stream_event':
        return this.onStreamEvent(message)
      case 'assistant':
        return this.onAssistant(message)
      case 'user':
        return this.onUser(message)
      case 'system':
        return this.onSystem(message)
      case 'result':
        return this.closeOpenBlocks()
      case 'permission_denied':
        return [
          this.append({
            kind: 'notice',
            id: this.nextId(),
            text: `${str(message['tool_name'])}: ${str(message['message']) || 'отклонено'}`,
            tone: 'error'
          })
        ]
      default:
        return []
    }
  }

  /** Something Qclod itself needs to say — a crash, a session that would not resume. */
  notice(text: string, tone: 'info' | 'error' = 'info'): RibbonChange[] {
    return [this.append({ kind: 'notice', id: this.nextId(), text, tone })]
  }

  // ------------------------------------------------------------- the stream

  private onStreamEvent(message: Record<string, unknown>): RibbonChange[] {
    const event = message['event']
    if (!isObject(event)) return []

    if (event['type'] === 'message_start') {
      const inner = event['message']
      const id = isObject(inner) ? str(inner['id']) : ''
      if (id) this.streamed.add(id)
      return []
    }

    if (event['type'] === 'content_block_stop') {
      return this.closeBlock(Number(event['index'] ?? 0))
    }

    if (event['type'] !== 'content_block_delta') return []
    const delta = event['delta']
    if (!isObject(delta)) return []

    const index = Number(event['index'] ?? 0)
    const parentId = this.parentOf(message)

    if (delta['type'] === 'text_delta') {
      return this.appendDelta(index, 'agentText', str(delta['text']), parentId)
    }
    if (delta['type'] === 'thinking_delta') {
      return this.appendDelta(index, 'thinking', str(delta['thinking']), parentId)
    }
    return []
  }

  private appendDelta(
    index: number,
    kind: 'agentText' | 'thinking',
    text: string,
    parentId: string | undefined
  ): RibbonChange[] {
    if (!text) return []
    const open = this.openBlocks.get(index)

    if (open && open.kind === kind) {
      const item = this.find(open.itemId)
      if (item && (item.kind === 'agentText' || item.kind === 'thinking')) {
        const next = item.text + text
        item.text = next
        return [this.update(item.id, { text: next })]
      }
    }

    const closed = open ? this.closeBlock(index) : []
    const id = this.nextId()
    const item: RibbonItem =
      kind === 'agentText'
        ? { kind: 'agentText', id, text, streaming: true, ...(parentId ? { parentId } : {}) }
        : { kind: 'thinking', id, text, done: false, durationMs: 0, ...(parentId ? { parentId } : {}) }

    this.openBlocks.set(index, { itemId: id, kind, startedAt: this.now() })
    return [...closed, this.append(item)]
  }

  private closeBlock(index: number): RibbonChange[] {
    const open = this.openBlocks.get(index)
    if (!open) return []
    this.openBlocks.delete(index)

    const item = this.find(open.itemId)
    if (!item) return []
    if (item.kind === 'agentText') {
      if (!item.streaming) return []
      item.streaming = false
      return [this.update(item.id, { streaming: false })]
    }
    if (item.kind === 'thinking') {
      if (item.done) return []
      const durationMs = this.now() - open.startedAt
      item.done = true
      item.durationMs = durationMs
      return [this.update(item.id, { done: true, durationMs })]
    }
    return []
  }

  private closeOpenBlocks(): RibbonChange[] {
    const changes: RibbonChange[] = []
    for (const index of [...this.openBlocks.keys()]) changes.push(...this.closeBlock(index))
    return changes
  }

  // ---------------------------------------------------------- the assistant

  private onAssistant(message: Record<string, unknown>): RibbonChange[] {
    const changes = this.closeOpenBlocks()
    const inner = message['message']
    if (!isObject(inner)) return changes

    // The complete message always follows the stream that produced it; its
    // text is already on screen, so only the blocks the stream cannot carry
    // (tool calls) are new.
    const alreadyStreamed = this.streamed.has(str(inner['id']))
    const parentId = this.parentOf(message)

    for (const block of asArray(inner['content'])) {
      if (!isObject(block)) continue
      switch (block['type']) {
        case 'text':
          if (alreadyStreamed) break
          if (!str(block['text']).trim()) break
          changes.push(
            this.append({
              kind: 'agentText',
              id: this.nextId(),
              text: str(block['text']),
              streaming: false,
              ...(parentId ? { parentId } : {})
            })
          )
          break

        case 'thinking':
          if (alreadyStreamed) break
          changes.push(
            this.append({
              kind: 'thinking',
              id: this.nextId(),
              text: str(block['thinking']),
              done: true,
              durationMs: 0,
              ...(parentId ? { parentId } : {})
            })
          )
          break

        case 'tool_use':
          changes.push(...this.onToolUse(block, parentId))
          break

        default:
          break
      }
    }
    return changes
  }

  private onToolUse(block: Record<string, unknown>, parentId: string | undefined): RibbonChange[] {
    const toolUseId = str(block['id'])
    const name = str(block['name'])
    const input = isObject(block['input']) ? block['input'] : {}

    // The to-do list is a pinned checklist, not a card: it is rewritten whole
    // on every call and would otherwise fill the ribbon with duplicates.
    if (name === 'TodoWrite') {
      const items = asArray(input['todos'])
        .filter(isObject)
        .map((todo) => ({ content: str(todo['content']), status: str(todo['status']) }))
      this.todoList = items
      return [{ kind: 'todo', items }]
    }

    if (name === 'AskUserQuestion') {
      const first = asArray(input['questions']).find(isObject)
      const options = first
        ? asArray(first['options'])
            .map((option) => (isObject(option) ? str(option['label']) : str(option)))
            .filter(Boolean)
        : []
      const id = this.nextId()
      this.byToolUseId.set(toolUseId, id)
      return [
        this.append({
          kind: 'question',
          id,
          toolUseId,
          question: first ? str(first['question']) : '',
          options,
          answer: null,
          ...(parentId ? { parentId } : {})
        })
      ]
    }

    // The subagent tool is «Agent». «Task» was a guess from older docs and
    // does not exist in this SDK at all — which is why a running subagent
    // showed up as an ordinary tool card and the panel's agent list stayed
    // empty while one was working. Both names are accepted: an older CLI is
    // cheaper to tolerate than to detect.
    if (name === 'Agent' || name === 'Task') {
      const id = this.nextId()
      this.byToolUseId.set(toolUseId, id)
      this.startedAt.set(id, this.now())
      return [
        this.append({
          kind: 'subagent',
          id,
          toolUseId,
          name: str(input['subagent_type']) || 'подагент',
          task: str(input['description']) || clip(str(input['prompt']), 120),
          state: 'running' as SubagentState,
          summary: '',
          ...(parentId ? { parentId } : {})
        })
      ]
    }

    const id = this.nextId()
    this.byToolUseId.set(toolUseId, id)
    return [
      this.append({
        kind: 'tool',
        id,
        toolUseId,
        name,
        target: toolTarget(name, input),
        summary: '',
        detail: '',
        state: 'running' as ToolState,
        ...(parentId ? { parentId } : {})
      })
    ]
  }

  // --------------------------------------------------------------- the user

  private onUser(message: Record<string, unknown>): RibbonChange[] {
    const inner = message['message']
    if (!isObject(inner)) return []
    const content = inner['content']

    // The summary a compaction leaves is written as a user message, but nobody
    // typed it: it belongs to the divider it follows, folded away there.
    if (message['isCompactSummary'] === true) return this.attachCompactSummary(content)

    // The news of a finished subagent, however it reaches us, closes its card;
    // it is never something the person typed.
    const noticeText =
      typeof content === 'string'
        ? content
        : asArray(content)
            .filter(isObject)
            .filter((b) => b['type'] === 'text')
            .map((b) => str(b['text']))
            .join('\n')
    const noticed: RibbonChange[] = []
    for (const notice of parseTaskNotifications(noticeText)) noticed.push(...this.applyNotice(notice))
    const origin = message['origin']
    if (isObject(origin) && origin['kind'] === 'task-notification') return noticed
    // Context the harness injected (skill text, reminders): never a bubble.
    if (message['isMeta'] === true || message['is_meta'] === true) return noticed
    // A subagent's prompt was written by the main agent, not the person.
    const fromAgent = str(message['parent_tool_use_id']) !== ''

    if (typeof content === 'string') {
      if (message['isSynthetic'] === true || fromAgent || this.consumeEcho(content)) return noticed
      const text = userText(content)
      return text === '' ? noticed : [...noticed, ...this.appendUser(text)]
    }

    const blocks = asArray(content).filter(isObject)
    const results = blocks.filter((b) => b['type'] === 'tool_result')
    if (results.length > 0) {
      const changes: RibbonChange[] = []
      // tool_use_result sits on the message, beside the blocks: the tool's own
      // structured output, which for Task carries the run totals.
      for (const block of results) changes.push(...this.onToolResult(block, message['tool_use_result']))
      return changes
    }

    if (message['isSynthetic'] === true || fromAgent) return noticed

    const text = userText(
      blocks
        .filter((b) => b['type'] === 'text')
        .map((b) => str(b['text']))
        .join('\n')
    )
    const attachments = blocks
      .filter((b) => b['type'] === 'image')
      .map(imageAttachment)
      .filter((a): a is Attachment => a !== null)

    if (!text && attachments.length === 0) return noticed
    if (this.consumeEcho(text)) return noticed
    return [...noticed, ...this.appendUser(text, attachments)]
  }

  private onToolResult(
    block: Record<string, unknown>,
    result?: unknown
  ): RibbonChange[] {
    const itemId = this.byToolUseId.get(str(block['tool_use_id']))
    if (!itemId) return []
    const item = this.find(itemId)
    if (!item) return []

    const text = resultText(block['content'])

    if (block['is_error'] === true) {
      // A failed subagent stays a subagent: it still has a place in the
      // panel's list and its nested stream, now marked as failed.
      if (item.kind === 'subagent') {
        const patch = { state: 'failed' as SubagentState, summary: clip(text, 160) }
        Object.assign(item, patch)
        return [this.update(item.id, patch)]
      }
      const name = item.kind === 'tool' ? item.name : ''
      const target = item.kind === 'tool' ? item.target : ''
      const replacement: RibbonItem = {
        kind: 'toolError',
        id: item.id,
        toolUseId: str(block['tool_use_id']),
        name,
        target,
        error: text,
        ...(item.parentId ? { parentId: item.parentId } : {})
      }
      this.list[this.list.indexOf(item)] = replacement
      return [this.update(item.id, { kind: 'toolError', error: text })]
    }

    if (item.kind === 'subagent') {
      // A background agent's call returns at once with async_launched; the
      // agent itself is only starting. Its text is a launch receipt, not a
      // result, so the summary is left alone.
      if (isObject(result) && (result['status'] === 'async_launched' || result['isAsync'] === true)) {
        const agentId = str(result['agentId'])
        const launch: Partial<Extract<RibbonItem, { kind: 'subagent' }>> = {
          background: true,
          ...(agentId ? { agentId } : {})
        }
        Object.assign(item, launch)
        return [this.update(item.id, launch)]
      }

      const patch: Partial<Extract<RibbonItem, { kind: 'subagent' }>> = { state: 'done', summary: clip(text, 160) }
      const stats = subagentStats(result)
      Object.assign(patch, stats)

      // The tool reports tokens but not how long it took, so the ribbon times
      // it from the card it placed.
      const began = this.startedAt.get(item.id)
      if (stats.durationMs === undefined && began !== undefined) {
        const measured = this.now() - began
        // A card that finished within the same millisecond has no duration
        // worth printing; «0 с» reads as a broken number.
        if (measured > 0) patch.durationMs = measured
      }
      Object.assign(item, patch)
      return [this.update(item.id, patch)]
    }

    if (item.kind === 'tool') {
      item.state = 'done'
      item.summary = toolSummary(item.name, text)
      item.detail = text
      return [this.update(item.id, { state: 'done', summary: item.summary, detail: text })]
    }

    return []
  }

  // ------------------------------------------------------------ task events

  private onSystem(message: Record<string, unknown>): RibbonChange[] {
    switch (message['subtype']) {
      case 'compact_boundary':
        return this.onCompaction(message)
      case 'task_started':
        return this.onTaskStarted(message)
      case 'task_progress':
        return this.onTaskProgress(message)
      case 'task_updated':
        return this.onTaskUpdated(message)
      case 'task_notification':
        return this.onTaskNotification(message)
      // background_tasks_changed is a level signal whose order against the
      // bookends is not promised; only a notice or task_updated closes a card.
      default:
        return []
    }
  }

  private subagentFor(toolUseId: string, taskId: string): SubagentItem | undefined {
    const id = (toolUseId && this.byToolUseId.get(toolUseId)) || (taskId && this.byTaskId.get(taskId))
    const item = id ? this.find(id) : undefined
    return item?.kind === 'subagent' ? item : undefined
  }

  private patchSubagent(item: SubagentItem, patch: Partial<SubagentItem>): RibbonChange[] {
    Object.assign(item, patch)
    return [this.update(item.id, patch)]
  }

  private onTaskStarted(message: Record<string, unknown>): RibbonChange[] {
    const taskId = str(message['task_id'])
    const item = this.subagentFor(str(message['tool_use_id']), '')
    if (!item || !taskId) return []
    this.byTaskId.set(taskId, item.id)
    const patch: Partial<SubagentItem> = { taskId }
    if (typeof message['is_backgrounded'] === 'boolean') patch.background = message['is_backgrounded']
    return this.patchSubagent(item, patch)
  }

  private onTaskProgress(message: Record<string, unknown>): RibbonChange[] {
    const item = this.subagentFor(str(message['tool_use_id']), str(message['task_id']))
    if (!item || item.state !== 'running') return []
    const usage = isObject(message['usage']) ? message['usage'] : {}
    const patch: Partial<SubagentItem> = {
      tokens: Number(usage['total_tokens'] ?? 0) || 0,
      toolCalls: Number(usage['tool_uses'] ?? 0) || 0,
      durationMs: Number(usage['duration_ms'] ?? 0) || 0
    }
    const last = str(message['last_tool_name'])
    if (last) patch.lastTool = last
    const summary = str(message['summary'])
    if (summary) patch.summary = clip(summary, 160)
    return this.patchSubagent(item, patch)
  }

  private onTaskUpdated(message: Record<string, unknown>): RibbonChange[] {
    const item = this.subagentFor('', str(message['task_id']))
    if (!item || item.state !== 'running') return []
    const patch = isObject(message['patch']) ? message['patch'] : {}
    const status = patch['status']
    if (status === 'completed') return this.patchSubagent(item, { state: 'done' })
    if (status === 'killed') return this.patchSubagent(item, { state: 'stopped' })
    if (status === 'failed') {
      const error = str(patch['error'])
      return this.patchSubagent(item, { state: 'failed', ...(error ? { summary: clip(error, 160) } : {}) })
    }
    return []
  }

  private onTaskNotification(message: Record<string, unknown>): RibbonChange[] {
    const usage = isObject(message['usage']) ? message['usage'] : undefined
    return this.applyNotice({
      taskId: str(message['task_id']),
      toolUseId: str(message['tool_use_id']),
      status: message['status'] as TaskNotice['status'],
      summary: str(message['summary']),
      ...(usage
        ? {
            usage: {
              tokens: Number(usage['total_tokens'] ?? 0) || 0,
              toolCalls: Number(usage['tool_uses'] ?? 0) || 0,
              durationMs: Number(usage['duration_ms'] ?? 0) || 0
            }
          }
        : {})
    })
  }

  /** A repeated notice for the same agent overwrites the earlier one. */
  private applyNotice(notice: TaskNotice): RibbonChange[] {
    const item = this.subagentFor(notice.toolUseId, notice.taskId)
    if (!item) return []
    const patch: Partial<SubagentItem> = {
      state: NOTICE_STATE[notice.status] ?? 'done',
      summary: clip(notice.summary, 160),
      lastTool: undefined,
      ...(notice.usage
        ? {
            tokens: notice.usage.tokens,
            toolCalls: notice.usage.toolCalls,
            durationMs: notice.usage.durationMs
          }
        : {})
    }
    return this.patchSubagent(item, patch)
  }

  private onCompaction(message: Record<string, unknown>): RibbonChange[] {
    const meta = isObject(message['compact_metadata']) ? message['compact_metadata'] : {}
    const pre = Number(meta['pre_tokens'] ?? 0)
    const post = Number(meta['post_tokens'] ?? 0)
    return [
      this.append({
        kind: 'compaction',
        id: this.nextId(),
        trigger: meta['trigger'] === 'manual' ? 'manual' : 'auto',
        freedTokens: Math.max(0, pre - post)
      })
    ]
  }

  /** Puts a compaction's summary into the latest divider, folded away. */
  private attachCompactSummary(content: unknown): RibbonChange[] {
    const summary =
      typeof content === 'string'
        ? content
        : asArray(content)
            .filter(isObject)
            .filter((b) => b['type'] === 'text')
            .map((b) => str(b['text']))
            .join('\n')
    const card = this.list.findLast((item) => item.kind === 'compaction')
    if (!card || card.kind !== 'compaction' || !summary) return []
    card.summary = summary
    return [this.update(card.id, { summary })]
  }

  // -------------------------------------------------------------- mechanics

  /** True when this text is the echo of a message we have already shown. */
  private consumeEcho(text: string): boolean {
    const at = this.pendingEchoes.indexOf(text)
    if (at === -1) return false
    this.pendingEchoes.splice(at, 1)
    return true
  }

  private appendUser(text: string, attachments: Attachment[] = []): RibbonChange[] {
    return [this.append({ kind: 'user', id: this.nextId(), text, attachments })]
  }

  private parentOf(message: Record<string, unknown>): string | undefined {
    const parent = str(message['parent_tool_use_id'])
    if (!parent) return undefined
    return this.byToolUseId.get(parent)
  }

  private find(id: string): RibbonItem | undefined {
    return this.list.find((item) => item.id === id)
  }

  private nextId(): string {
    return `r${++this.seq}`
  }

  private append(item: RibbonItem): RibbonChange {
    this.list.push(item)
    return { kind: 'append', item }
  }

  private update(id: string, patch: Partial<RibbonItem>): RibbonChange {
    return { kind: 'update', id, patch }
  }
}
