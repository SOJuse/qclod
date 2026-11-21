import type {
  Attachment,
  NoticeAction,
  QuestionView,
  RibbonChange,
  RibbonItem,
  SubagentItem,
  SubagentState,
  TodoItem,
  ToolState
} from './types'
import { clipForView, clipText } from './clip'
import { clip, lines } from './format'

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
  /**
   * The messages come from a stored conversation: the clock now says nothing
   * about when a call was made, so cards get no start time or duration until
   * finishReplay().
   */
  replay?: boolean
}

/**
 * A content block currently being streamed, keyed by its parent card and its
 * index in the message: ten subagents streaming at once all use index 0.
 */
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

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1]! : path
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
 * The tool's structured output, bounded — with the counts the card prints
 * taken first. A created file of 100 KB or a patch of thousands of lines
 * would otherwise be counted from what is left after clipping.
 */
function clipOutput(result: unknown): unknown {
  const clipped = clipForView(result)
  if (!isObject(result) || Array.isArray(result) || !isObject(clipped)) return clipped

  const counts: Record<string, number> = {}
  if (Array.isArray(result['structuredPatch'])) {
    let added = 0
    let removed = 0
    for (const hunk of result['structuredPatch']) {
      if (!isObject(hunk)) continue
      for (const line of asArray(hunk['lines'])) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
    }
    counts['added'] = added
    counts['removed'] = removed
  }
  if (typeof result['content'] === 'string') {
    counts['size'] = result['content'].length
    counts['totalLines'] = result['content'] === '' ? 0 : result['content'].split('\n').length
  }
  if (Object.keys(counts).length > 0) clipped['_counts'] = counts
  return clipped
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

/** The most a subagent's report keeps: enough to read, not a book. */
const REPORT_CLIP = 8000

function clipReport(text: string): string {
  return clipText(text, REPORT_CLIP)
}

/** A subagent's prompt, kept on its card. */
const PROMPT_CLIP = 8000
/** One text or thought of a subagent's own conversation, whole from the CLI. */
const NESTED_CLIP = 20000

/**
 * What a finished subagent wrote back, whole: the text blocks of AgentOutput's
 * content as paragraphs, or the tool_result's text when the output has no
 * such structure. Line breaks are kept; only the length is bounded.
 */
function subagentReport(result: unknown, fallback: string): string {
  const blocks = isObject(result) ? asArray(result['content']).filter(isObject) : []
  const texts = blocks.filter((b) => b['type'] === 'text').map((b) => str(b['text'])).filter(Boolean)
  return clipReport(texts.length > 0 ? texts.join('\n\n') : fallback)
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
  /**
   * A subagent's agent_id / task_id (one and the same, probe 05b) -> its
   * card: from task_started, AgentOutput.agentId and async_launched.agentId.
   * Its messages are routed by it first: a resumed agent's may point at the
   * SendMessage call rather than at its own Agent call.
   */
  private readonly byAgentId = new Map<string, string>()
  /** When each subagent card was placed, for timing it ourselves. */
  private readonly startedAt = new Map<string, number>()
  /** Keyed `${parentId ?? ''}:${index}`. */
  private readonly openBlocks = new Map<string, OpenBlock>()
  /** Message ids whose text already reached the ribbon as deltas. */
  private readonly streamed = new Set<string>()
  private todoList: TodoItem[] | null = null
  /**
   * Text already shown because the user just typed it. The CLI echoes every
   * message back, and the echo must not become a second copy of it on screen.
   */
  private readonly pendingEchoes: Array<{ text: string; uuid?: string }> = []
  private seq = 0
  /** When the message before the current one arrived: a thinking block that comes whole took that long. */
  private previousEventAt: number | undefined
  private lastEventAt: number | undefined
  /**
   * The last point a streamed block could have begun: the message's start or
   * the end of the block before. Thinking starts there, not at its first
   * delta, which comes only after the model has been thinking for a while.
   */
  private readonly blockBoundaryAt = new Map<string, number>()
  /** The message being applied: what a subagent card's end time is read from. */
  private current: Record<string, unknown> | null = null
  private readonly now: () => number
  private replaying: boolean
  private remoteLive = false

  constructor(options: Clock = {}) {
    this.now = options.now ?? (() => Date.now())
    this.replaying = options.replay === true
  }

  get items(): RibbonItem[] {
    return this.list
  }

  get todo(): TodoItem[] | null {
    return this.todoList
  }

  /** The subagent card with this id — what the window names when it writes to or stops an agent. */
  subagentCard(cardId: string): SubagentItem | undefined {
    const item = this.find(cardId)
    return item?.kind === 'subagent' ? item : undefined
  }

  /**
   * The user's own message, when it is not coming back from the SDK as an echo
   * — a replayed history entry arrives as a `user` message instead.
   */
  addUser(
    text: string,
    attachments: Attachment[] = [],
    echoKey: string | null = text,
    uuid?: string,
    opts: { auto?: boolean } = {}
  ): RibbonChange[] {
    // What is shown and what will be echoed are not always the same string:
    // an attached file reaches the agent as an @-mention appended to the text.
    // null: no echo is coming (a message the CLI folded into a turn).
    if (echoKey !== null) this.expectEcho(echoKey, uuid)
    // `auto`: sent by Qclod itself («продолжай»), not by the person.
    return [
      this.append({
        kind: 'user',
        id: this.nextId(),
        text,
        attachments,
        at: this.now(),
        ...(opts.auto ? { auto: true as const } : {})
      })
    ]
  }

  /**
   * An echo to swallow when it comes. With the uuid the message went under,
   * the expectation ends at the result of the turn that carried it: CLI
   * 2.1.317 echoes nothing, and a stale one would swallow the same words
   * typed later — on the phone, say.
   */
  expectEcho(text: string, uuid?: string): void {
    this.pendingEchoes.push(uuid ? { text, uuid } : { text })
  }

  /** Nothing more comes back from a process that is gone. */
  forgetEchoes(): void {
    this.pendingEchoes.length = 0
  }

  /** The turn is over: an echo of what it carried that has not come will not. */
  private expireEchoes(message: Record<string, unknown>): void {
    const carried = message['user_message_uuids']
    if (!Array.isArray(carried)) return
    const done = new Set(carried.filter((u): u is string => typeof u === 'string'))
    for (let i = this.pendingEchoes.length - 1; i >= 0; i -= 1) {
      const uuid = this.pendingEchoes[i]!.uuid
      if (uuid !== undefined && done.has(uuid)) this.pendingEchoes.splice(i, 1)
    }
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

  /**
   * The plan decided. `comment` is what the user said with it; `edited` with
   * `plan` — the plan was approved as the user changed it, and the card shows
   * that text from now on. `sentBack` with `rejected` — it was approved so,
   * and sent back for rework rather than refused (S2-R8).
   */
  resolvePlan(
    requestId: string,
    state: 'approved' | 'rejected' | 'elsewhere',
    extra: { comment?: string; edited?: true; plan?: string; sentBack?: true; auto?: boolean } = {}
  ): RibbonChange[] {
    const item = this.list.find((i) => i.kind === 'plan' && i.requestId === requestId)
    if (!item || item.kind !== 'plan') return []
    const patch: Partial<Extract<RibbonItem, { kind: 'plan' }>> = { state }
    if (extra.comment) patch.comment = extra.comment
    // Decided by Qclod's timer in «авто-да», not by the person.
    if (extra.auto) patch.auto = true
    if (extra.sentBack && state === 'rejected') patch.sentBack = true
    if (extra.edited && extra.plan !== undefined) {
      patch.text = extra.plan
      patch.edited = true
    }
    Object.assign(item, patch)
    return [this.update(item.id, patch)]
  }

  /** The permission answered: how it was allowed (`scope`), or why it was denied (`reason`). */
  resolvePermission(
    requestId: string,
    state: 'allowed' | 'denied' | 'elsewhere',
    extra: { scope?: 'once' | 'always' | 'session'; reason?: string } = {}
  ): RibbonChange[] {
    const item = this.list.find((i) => i.kind === 'permission' && i.requestId === requestId)
    if (!item || item.kind !== 'permission') return []
    const patch: Partial<Extract<RibbonItem, { kind: 'permission' }>> = { state }
    if (extra.scope) patch.scope = extra.scope
    if (extra.reason) patch.reason = extra.reason
    Object.assign(item, patch)
    return [this.update(item.id, patch)]
  }

  /** Whether a card for this tool call is already in the ribbon. */
  hasToolUse(toolUseId: string): boolean {
    return this.byToolUseId.has(toolUseId)
  }

  /** Records the user's answer to a question card, with the comments on the chosen options. */
  answerQuestion(
    toolUseId: string,
    answers: Record<string, string>,
    extra: { notes?: Record<string, string>; auto?: boolean } = {}
  ): RibbonChange[] {
    const item = this.list.find((i) => i.kind === 'question' && i.toolUseId === toolUseId)
    if (!item || item.kind !== 'question') return []
    // Kept on the item itself: a snapshot (reload, split pane, a session
    // taking this ribbon over) is built from the items, not from the events.
    const patch: Partial<Extract<RibbonItem, { kind: 'question' }>> = { answers }
    if (extra.notes && Object.keys(extra.notes).length > 0) patch.notes = extra.notes
    // Answered by Qclod's timer in «авто-да», not by the person.
    if (extra.auto) patch.auto = true
    Object.assign(item, patch)
    return [this.update(item.id, patch)]
  }

  /**
   * A question answered on another device (Remote Control) closes the card
   * the way an answer does — `answers` is no longer null — with no answers of ours.
   */
  closeQuestionElsewhere(toolUseId: string): RibbonChange[] {
    const item = this.list.find((i) => i.kind === 'question' && i.toolUseId === toolUseId)
    if (!item || item.kind !== 'question' || item.answers !== null) return []
    item.answers = {}
    item.elsewhere = true
    return [this.update(item.id, { answers: item.answers, elsewhere: true })]
  }

  /** Whether the Remote Control bridge is live: a person's message from the stream then came from elsewhere. */
  setRemote(live: boolean): void {
    this.remoteLive = live
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
    this.replaying = false
    return this.closeOpen()
  }

  apply(message: unknown): RibbonChange[] {
    if (!isObject(message)) return []
    this.previousEventAt = this.lastEventAt
    this.lastEventAt = this.now()
    this.current = message
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
        this.expireEchoes(message)
        return [...this.closeOpenBlocks(), ...this.onResult(message)]
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
  notice(
    text: string,
    tone: 'info' | 'error' = 'info',
    action?: NoticeAction
  ): RibbonChange[] {
    return [this.append({ kind: 'notice', id: this.nextId(), text, tone, ...(action ? { action } : {}) })]
  }

  /**
   * The turn is over: the line under the answer says when, and how long it
   * took. A slash command answered locally — no model call, no turn — gets
   * none; neither does a replay, whose record has no results.
   */
  private onResult(message: Record<string, unknown>): RibbonChange[] {
    if (this.replaying) return []
    const turns = Number(message['num_turns'] ?? 0) || 0
    const apiMs = Number(message['duration_api_ms'] ?? 0) || 0
    if (turns === 0 && apiMs === 0) return []
    const durationMs = Number(message['duration_ms'] ?? 0) || 0
    const failed = message['is_error'] === true || (str(message['subtype']) !== '' && message['subtype'] !== 'success')
    return [
      this.append({
        kind: 'turnEnd',
        id: this.nextId(),
        at: this.now(),
        ...(durationMs > 0 ? { durationMs } : {}),
        ...(failed ? { failed: true as const } : {})
      })
    ]
  }

  // ------------------------------------------------------------- the stream

  private onStreamEvent(message: Record<string, unknown>): RibbonChange[] {
    const event = message['event']
    if (!isObject(event)) return []

    const parentId = this.parentOf(message)
    const scope = parentId ?? ''

    if (event['type'] === 'message_start') {
      const inner = event['message']
      const id = isObject(inner) ? str(inner['id']) : ''
      if (id) this.streamed.add(id)
      this.blockBoundaryAt.set(scope, this.now())
      return []
    }

    const key = `${scope}:${Number(event['index'] ?? 0)}`
    if (event['type'] === 'content_block_stop') {
      const changes = this.closeBlock(key)
      this.blockBoundaryAt.set(scope, this.now())
      return changes
    }

    if (event['type'] !== 'content_block_delta') return []
    const delta = event['delta']
    if (!isObject(delta)) return []

    if (delta['type'] === 'text_delta') {
      return this.appendDelta(key, 'agentText', str(delta['text']), parentId)
    }
    if (delta['type'] === 'thinking_delta') {
      return this.appendDelta(key, 'thinking', str(delta['thinking']), parentId)
    }
    return []
  }

  private appendDelta(
    key: string,
    kind: 'agentText' | 'thinking',
    text: string,
    parentId: string | undefined
  ): RibbonChange[] {
    if (!text) return []
    const open = this.openBlocks.get(key)

    if (open && open.kind === kind) {
      const item = this.find(open.itemId)
      if (item && (item.kind === 'agentText' || item.kind === 'thinking')) {
        const next = item.text + text
        item.text = next
        return [this.update(item.id, { text: next })]
      }
    }

    const closed = open ? this.closeBlock(key) : []
    const id = this.nextId()
    const item: RibbonItem =
      kind === 'agentText'
        ? { kind: 'agentText', id, text, streaming: true, ...(parentId ? { parentId } : {}) }
        : { kind: 'thinking', id, text, done: false, durationMs: 0, ...(parentId ? { parentId } : {}) }

    const startedAt = kind === 'thinking' ? (this.blockBoundaryAt.get(parentId ?? '') ?? this.now()) : this.now()
    this.openBlocks.set(key, { itemId: id, kind, startedAt })
    return [...closed, this.append(item)]
  }

  private closeBlock(key: string): RibbonChange[] {
    const open = this.openBlocks.get(key)
    if (!open) return []
    this.openBlocks.delete(key)

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

  /** A thinking block that came whole was being thought since the event before it; a replay has no clock. */
  private wholeThinkingMs(): number {
    if (this.replaying || this.previousEventAt === undefined) return 0
    return Math.max(0, this.now() - this.previousEventAt)
  }

  /** With `parentId` given, only that stream's blocks: another agent may still be writing. */
  private closeOpenBlocks(parentId?: string | null): RibbonChange[] {
    const changes: RibbonChange[] = []
    const prefix = parentId === undefined ? null : `${parentId ?? ''}:`
    for (const key of [...this.openBlocks.keys()]) {
      if (prefix === null || key.startsWith(prefix)) changes.push(...this.closeBlock(key))
    }
    return changes
  }

  // ---------------------------------------------------------- the assistant

  private onAssistant(message: Record<string, unknown>): RibbonChange[] {
    const parentId = this.parentOf(message)
    // The message closes its own stream, not a neighbour's still being written.
    const changes = this.closeOpenBlocks(parentId ?? null)
    const inner = message['message']
    if (!isObject(inner)) return changes

    // The complete message always follows the stream that produced it; its
    // text is already on screen, so only the blocks the stream cannot carry
    // (tool calls) are new.
    const alreadyStreamed = this.streamed.has(str(inner['id']))
    // A subagent's whole text comes in one piece; a book of it is not kept.
    const nested = (text: string): string => (parentId ? clipText(text, NESTED_CLIP) : text)

    for (const block of asArray(inner['content'])) {
      if (!isObject(block)) continue
      switch (block['type']) {
        case 'text': {
          if (alreadyStreamed) break
          if (!str(block['text']).trim()) break
          // «/chrome isn't available in this environment.» is the CLI talking,
          // not the model: it becomes a notice with a way out.
          const local = inner['model'] === '<synthetic>' ? this.commandNotice(str(block['text'])) : null
          if (local) {
            changes.push(this.append(local))
            break
          }
          changes.push(
            this.append({
              kind: 'agentText',
              id: this.nextId(),
              text: nested(str(block['text'])),
              streaming: false,
              ...(parentId ? { parentId } : {})
            })
          )
          break
        }

        case 'thinking':
          if (alreadyStreamed) break
          changes.push(
            this.append({
              kind: 'thinking',
              id: this.nextId(),
              text: nested(str(block['thinking'])),
              done: true,
              durationMs: this.wholeThinkingMs(),
              ...(parentId ? { parentId } : {})
            })
          )
          break

        case 'tool_use':
          changes.push(...this.onToolUse(block, parentId, this.messageTime(message)))
          break

        default:
          break
      }
    }
    return changes
  }

  private onToolUse(block: Record<string, unknown>, parentId: string | undefined, at?: number): RibbonChange[] {
    const toolUseId = str(block['id'])
    const name = str(block['name'])
    const input = isObject(block['input']) ? block['input'] : {}

    // The to-do list is a pinned checklist, not a card: it is rewritten whole
    // on every call and would otherwise fill the ribbon with duplicates.
    if (name === 'TodoWrite') {
      const items = asArray(input['todos'])
        .filter(isObject)
        .map((todo): TodoItem => {
          const activeForm = str(todo['activeForm'])
          return {
            content: str(todo['content']),
            status: str(todo['status']),
            ...(activeForm ? { activeForm } : {})
          }
        })
      this.todoList = items
      return [{ kind: 'todo', items }]
    }

    if (name === 'AskUserQuestion') {
      const questions: QuestionView[] = asArray(input['questions'])
        .filter(isObject)
        .map((q) => ({
          question: str(q['question']),
          header: str(q['header']),
          multiSelect: q['multiSelect'] === true,
          options: asArray(q['options'])
            .map((option) => ({
              label: isObject(option) ? str(option['label']) : str(option),
              description: isObject(option) ? str(option['description']) : ''
            }))
            .filter((option) => option.label !== '')
        }))
      const id = this.nextId()
      this.byToolUseId.set(toolUseId, id)
      return [
        this.append({
          kind: 'question',
          id,
          toolUseId,
          questions,
          answers: null,
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
      const prompt = str(input['prompt'])
      const label = str(input['name'])
      return [
        this.append({
          kind: 'subagent',
          id,
          toolUseId,
          name: str(input['subagent_type']) || 'подагент',
          task: str(input['description']) || clip(prompt, 120),
          state: 'running' as SubagentState,
          summary: '',
          ...(prompt ? { prompt: clipText(prompt, PROMPT_CLIP) } : {}),
          ...(label ? { label } : {}),
          ...(at !== undefined ? { startedAt: at } : {}),
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
        input: clipForView(input) as Record<string, unknown>,
        ...(this.replaying ? {} : { startedAt: this.now() }),
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
      return text === '' ? noticed : [...noticed, ...this.appendUser(text, [], this.messageTime(message))]
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
    return [...noticed, ...this.appendUser(text, attachments, this.messageTime(message))]
  }

  private onToolResult(
    block: Record<string, unknown>,
    result?: unknown
  ): RibbonChange[] {
    const itemId = this.byToolUseId.get(str(block['tool_use_id']))
    if (!itemId) return []
    const item = this.find(itemId)
    if (!item) return []

    // The text is kept for the card whole-ish: a megabyte of stdout is not.
    const whole = resultText(block['content'])
    const text = clipText(whole)

    if (block['is_error'] === true) {
      // A failed subagent stays a subagent: it still has a place in the
      // panel's list and its nested stream, now marked as failed.
      if (item.kind === 'subagent') {
        // Stopped: the call's error that follows («Request interrupted…») is the stop itself.
        if (item.state === 'stopped') return []
        return this.patchSubagent(item, { state: 'failed', summary: clip(text, 160) })
      }
      const name = item.kind === 'tool' ? item.name : ''
      const target = item.kind === 'tool' ? item.target : ''
      const call = item.kind === 'tool' ? this.callResult(item, result) : {}
      const replacement: RibbonItem = {
        kind: 'toolError',
        id: item.id,
        toolUseId: str(block['tool_use_id']),
        name,
        target,
        error: text,
        ...(item.kind === 'tool' && item.input ? { input: item.input } : {}),
        ...(item.kind === 'tool' && item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
        ...call,
        ...(item.parentId ? { parentId: item.parentId } : {})
      }
      this.list[this.list.indexOf(item)] = replacement
      return [this.update(item.id, { kind: 'toolError', error: text, ...call })]
    }

    if (item.kind === 'subagent') {
      // A background agent's call returns at once with async_launched; the
      // agent itself is only starting. Its text is a launch receipt, not a
      // result, so the summary is left alone.
      if (isObject(result) && (result['status'] === 'async_launched' || result['isAsync'] === true)) {
        const agentId = str(result['agentId'])
        const model = str(result['resolvedModel'])
        if (agentId) this.byAgentId.set(agentId, item.id)
        return this.patchSubagent(item, {
          background: true,
          ...(agentId ? { agentId } : {}),
          ...(model ? { model } : {})
        })
      }

      const patch: Partial<Extract<RibbonItem, { kind: 'subagent' }>> = { state: 'done', summary: clip(text, 160) }
      if (isObject(result)) {
        const agentId = str(result['agentId'])
        if (agentId) {
          this.byAgentId.set(agentId, item.id)
          patch.agentId = agentId
        }
        const model = str(result['resolvedModel'])
        if (model) patch.model = model
      }
      const report = subagentReport(result, whole)
      if (report) patch.report = report
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
      return this.patchSubagent(item, patch)
    }

    if (item.kind === 'tool') {
      const call = this.callResult(item, result)
      item.state = 'done'
      item.summary = toolSummary(item.name, whole)
      item.detail = text
      Object.assign(item, call)
      return [this.update(item.id, { state: 'done', summary: item.summary, detail: text, ...call })]
    }

    return []
  }

  /**
   * What a finished call adds to its card: the tool's structured output, kept
   * bounded, and how long the call took. An output the tool did not send is
   * simply absent; so is a duration of nothing (the same millisecond).
   */
  private callResult(
    item: Extract<RibbonItem, { kind: 'tool' }>,
    result: unknown
  ): { output?: unknown; durationMs?: number } {
    const call: { output?: unknown; durationMs?: number } = {}
    if (result !== undefined && result !== null) call.output = clipOutput(result)
    if (item.startedAt !== undefined) {
      const measured = this.now() - item.startedAt
      if (measured > 0) call.durationMs = measured
    }
    return call
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

  /**
   * The card a task event is about: by its task id first — the agent's
   * identity; a resumed run's tool_use_id is the SendMessage call's — then
   * by the call.
   */
  private subagentFor(toolUseId: string, taskId: string): SubagentItem | undefined {
    for (const id of [taskId && this.byAgentId.get(taskId), toolUseId && this.byToolUseId.get(toolUseId)]) {
      const item = id ? this.find(id) : undefined
      if (item?.kind === 'subagent') return item
    }
    return undefined
  }

  /** A card leaving `running` gets its end time: this message's, or now. */
  private patchSubagent(item: SubagentItem, patch: Partial<SubagentItem>): RibbonChange[] {
    const ending = patch.state !== undefined && patch.state !== 'running'
    if (item.state === 'running' && ending && patch.endedAt === undefined) {
      const at = this.current ? this.messageTime(this.current) : undefined
      if (at !== undefined) patch = { ...patch, endedAt: at }
    }
    Object.assign(item, patch)
    return [this.update(item.id, patch)]
  }

  private onTaskStarted(message: Record<string, unknown>): RibbonChange[] {
    const taskId = str(message['task_id'])
    if (!taskId) return []
    const toolUseId = str(message['tool_use_id'])
    const backgrounded = typeof message['is_backgrounded'] === 'boolean' ? message['is_backgrounded'] : undefined

    // The same agent started again — SendMessage resumed it: the same card, running anew.
    const known = this.subagentFor('', taskId)
    if (known && known.state !== 'running') {
      return this.patchSubagent(known, {
        state: 'running',
        runs: (known.runs ?? 1) + 1,
        endedAt: undefined,
        summary: '',
        ...(backgrounded !== undefined ? { background: backgrounded } : {})
      })
    }

    const item = known ?? this.subagentFor(toolUseId, '')
    if (item) {
      this.byAgentId.set(taskId, item.id)
      const patch: Partial<SubagentItem> = { taskId }
      if (backgrounded !== undefined) patch.background = backgrounded
      return this.patchSubagent(item, patch)
    }

    // An agent whose call never reached the stream — a nested one the CLI did
    // not forward: a card of its own, under its parent's when that is known.
    if (str(message['task_type']) !== 'local_agent') return []
    const id = this.nextId()
    if (toolUseId) this.byToolUseId.set(toolUseId, id)
    this.byAgentId.set(taskId, id)
    this.startedAt.set(id, this.now())
    const parentTask = str(message['parent_task_id'])
    const parentId = parentTask ? this.byAgentId.get(parentTask) : undefined
    const at = this.messageTime(message)
    return [
      this.append({
        kind: 'subagent',
        id,
        toolUseId,
        name: str(message['subagent_type']) || 'подагент',
        task: str(message['description']),
        state: 'running',
        summary: '',
        background: backgrounded === true,
        taskId,
        ...(at !== undefined ? { startedAt: at } : {}),
        ...(parentId ? { parentId } : {})
      })
    ]
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
    // Moved to the background: by backgroundTask(), or the CLI itself on a 'now' message.
    const moved =
      patch['is_backgrounded'] === true && item.background !== true ? this.patchSubagent(item, { background: true }) : []
    const status = patch['status']
    if (status === 'completed') return [...moved, ...this.patchSubagent(item, { state: 'done' })]
    if (status === 'killed') return [...moved, ...this.patchSubagent(item, { state: 'stopped' })]
    if (status === 'failed') {
      const error = str(patch['error'])
      return [...moved, ...this.patchSubagent(item, { state: 'failed', ...(error ? { summary: clip(error, 160) } : {}) })]
    }
    return moved
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
      // A background agent's only words back are the notice's summary; a
      // foreground one already has its whole report from the tool's output.
      ...(notice.summary && (item.background || !item.report) ? { report: clipReport(notice.summary) } : {}),
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
    const at = this.pendingEchoes.findIndex((e) => e.text === text)
    if (at === -1) return false
    this.pendingEchoes.splice(at, 1)
    return true
  }

  private appendUser(text: string, attachments: Attachment[] = [], at?: number): RibbonChange[] {
    const remote = this.remoteLive && !this.replaying
    return [
      this.append({
        kind: 'user',
        id: this.nextId(),
        text,
        attachments,
        ...(remote ? { remote: true as const } : {}),
        ...(at !== undefined ? { at } : {})
      })
    ]
  }

  /**
   * When a message was written: the record's own timestamp, or — live — now.
   * A replayed message without one has no time rather than a wrong one.
   */
  private messageTime(message: Record<string, unknown>): number | undefined {
    const stamp = message['timestamp']
    if (typeof stamp === 'string') {
      const parsed = Date.parse(stamp)
      if (!Number.isNaN(parsed)) return parsed
    }
    return this.replaying ? undefined : this.now()
  }

  /**
   * The CLI's own one-line answers to a slash command it will not run here,
   * in the words of the person using Qclod. Null for any other text.
   */
  private commandNotice(text: string): RibbonItem | null {
    const line = text.trim()
    const unavailable = /^\/(\S+) isn't available (?:in this environment|over Remote Control)\.?$/.exec(line)
    if (unavailable) {
      return {
        kind: 'notice',
        id: this.nextId(),
        text:
          `Команда /${unavailable[1]} работает только в терминальном Claude Code — в окне Qclod её нет. ` +
          'Откройте терминал и наберите её там.',
        tone: 'info',
        action: 'terminal'
      }
    }
    const unknown = /^Unknown (?:command|skill): \/?(\S+?)(?:\.|$)/.exec(line)
    if (unknown) {
      return {
        kind: 'notice',
        id: this.nextId(),
        text: `Неизвестная команда /${unknown[1]}. Список команд — по «/» в поле ввода.`,
        tone: 'info'
      }
    }
    return null
  }

  /**
   * The card a nested message belongs to: its agent_id first, then the call
   * it names. A resumed agent's messages keep their agent_id while the call
   * they name may be the SendMessage that woke it (Review Focus 2).
   */
  private parentOf(message: Record<string, unknown>): string | undefined {
    const agent = str(message['agent_id'])
    const byAgent = agent ? this.byAgentId.get(agent) : undefined
    if (byAgent) return byAgent
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
