import type { Attachment, RibbonChange, RibbonItem, TodoItem, ToolState } from './types'

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
  addUser(text: string, attachments: Attachment[] = []): RibbonChange[] {
    this.pendingEchoes.push(text)
    return [this.append({ kind: 'user', id: this.nextId(), text, attachments })]
  }

  /** Records the user's answer to a question card. */
  answerQuestion(toolUseId: string, answer: string): RibbonChange[] {
    const item = this.list.find((i) => i.kind === 'question' && i.toolUseId === toolUseId)
    if (!item) return []
    return [this.update(item.id, { answer })]
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
        return message['subtype'] === 'compact_boundary' ? this.onCompaction(message) : []
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

    if (name === 'Task') {
      const id = this.nextId()
      this.byToolUseId.set(toolUseId, id)
      return [
        this.append({
          kind: 'subagent',
          id,
          toolUseId,
          name: str(input['description']) || str(input['subagent_type']) || 'подагент',
          state: 'running' as ToolState,
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

    if (typeof content === 'string') {
      if (message['isSynthetic'] === true || this.consumeEcho(content)) return []
      return this.appendUser(content)
    }

    const blocks = asArray(content).filter(isObject)
    const results = blocks.filter((b) => b['type'] === 'tool_result')
    if (results.length > 0) {
      const changes: RibbonChange[] = []
      for (const block of results) changes.push(...this.onToolResult(block))
      return changes
    }

    if (message['isSynthetic'] === true) return []

    const text = blocks
      .filter((b) => b['type'] === 'text')
      .map((b) => str(b['text']))
      .join('\n')
    const attachments = blocks
      .filter((b) => b['type'] === 'image')
      .map(imageAttachment)
      .filter((a): a is Attachment => a !== null)

    if (!text && attachments.length === 0) return []
    if (this.consumeEcho(text)) return []
    return this.appendUser(text, attachments)
  }

  private onToolResult(block: Record<string, unknown>): RibbonChange[] {
    const itemId = this.byToolUseId.get(str(block['tool_use_id']))
    if (!itemId) return []
    const item = this.find(itemId)
    if (!item) return []

    const text = resultText(block['content'])

    if (block['is_error'] === true) {
      const name = item.kind === 'tool' || item.kind === 'subagent' ? item.name : ''
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
      item.state = 'done'
      item.summary = clip(text, 120)
      return [this.update(item.id, { state: 'done', summary: item.summary })]
    }

    if (item.kind === 'tool') {
      item.state = 'done'
      item.summary = toolSummary(item.name, text)
      item.detail = text
      return [this.update(item.id, { state: 'done', summary: item.summary, detail: text })]
    }

    return []
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
