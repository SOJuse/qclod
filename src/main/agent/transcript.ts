import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * A past conversation, read straight from the CLI's own session file.
 *
 * The SDK's getSessionMessages hands back a trimmed chain: no tool results'
 * structured output, nothing before the last compaction, no subagent steps.
 * Reopening a chat from that showed half of it. The file itself has all of
 * it, so it is read here — only read: nothing in this module opens a file for
 * writing, and a test holds it to that.
 *
 * What comes out is shaped like the SDK's live stream, so the ribbon replays
 * it with the same code that draws a live session.
 */

type Line = Record<string, unknown>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Where the CLI keeps its state: CLAUDE_CONFIG_DIR, or ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return env['CLAUDE_CONFIG_DIR'] || join(home, '.claude')
}

/** The project folder name the CLI derives from a cwd (`sl()` in sdk.mjs). */
function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * `<configDir>/projects/<cwd as a folder name>/<sessionId>.jsonl`. The CLI
 * shortens a long cwd's folder name with a hash, so on a miss every project
 * folder is tried for the same file name, as getSessionInfo does without a dir.
 */
export function findTranscript(sessionId: string, cwd: string, configDir: string): string | null {
  // The id comes from tabs.json; it must name a file, never a path.
  if (!sessionId || /[\\/]/.test(sessionId) || sessionId === '.' || sessionId === '..') return null
  const projects = join(configDir, 'projects')
  const file = `${sessionId}.jsonl`

  const direct = join(projects, projectDirName(cwd), file)
  if (isFile(direct)) return direct

  let folders: string[]
  try {
    folders = readdirSync(projects, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return null
  }
  for (const folder of folders) {
    const candidate = join(projects, folder, file)
    if (isFile(candidate)) return candidate
  }
  return null
}

/** Every line that parses; a broken one (a crash mid-write) is skipped. */
async function readLines(path: string): Promise<Line[]> {
  const stream = createReadStream(path, { encoding: 'utf8', flags: 'r' })
  try {
    await once(stream, 'open')
  } catch (error) {
    stream.destroy()
    throw error
  }
  const lines: Line[] = []
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const raw of reader) {
    if (!raw.trim()) continue
    try {
      const line: unknown = JSON.parse(raw)
      if (isObject(line)) lines.push(line)
    } catch {
      // Not a line we can use.
    }
  }
  return lines
}

const CONVERSATION = new Set(['user', 'assistant', 'attachment'])

/**
 * The conversation as the CLI resumes it: from the last line back by
 * parentUuid, across a compaction by its logicalParentUuid. A branch the
 * person rewound past is still in the file but on no line's way back, so it
 * stays out.
 */
function chainOf(lines: Line[]): Line[] {
  const byUuid = new Map<string, Line>()
  for (const line of lines) if (typeof line['uuid'] === 'string') byUuid.set(line['uuid'], line)

  let leaf: Line | undefined
  for (const line of lines) {
    if (CONVERSATION.has(String(line['type'])) && line['isSidechain'] !== true) leaf = line
  }

  const chain: Line[] = []
  const seen = new Set<Line>()
  for (let at = leaf; at && !seen.has(at); ) {
    seen.add(at)
    chain.push(at)
    let parent = at['parentUuid']
    if (parent == null && at['type'] === 'system' && at['subtype'] === 'compact_boundary') {
      parent = at['logicalParentUuid']
    }
    at = typeof parent === 'string' ? byUuid.get(parent) : undefined
  }
  return chain.reverse()
}

const FLAGS = ['isSynthetic', 'isMeta', 'isCompactSummary', 'origin'] as const

/** One file line as the SDK would have streamed it, or null for what the stream never carries. */
function toMessage(line: Line): Line | null {
  const type = line['type']

  if (type === 'user' || type === 'assistant') {
    const message: Line = {
      type,
      uuid: line['uuid'],
      message: line['message'],
      parent_tool_use_id: null
    }
    if (line['toolUseResult'] !== undefined) message['tool_use_result'] = line['toolUseResult']
    for (const flag of FLAGS) if (line[flag] !== undefined) message[flag] = line[flag]
    return message
  }

  if (type === 'system' && line['subtype'] === 'compact_boundary') {
    const meta = isObject(line['compactMetadata']) ? line['compactMetadata'] : {}
    return {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: meta['trigger'],
        pre_tokens: meta['preTokens'],
        post_tokens: meta['postTokens']
      }
    }
  }

  // Whatever was queued while the main agent was busy is written only as this
  // attachment: a background agent's notice, or a message the person typed
  // mid-turn. The stream would have carried either as a user message.
  const prompt = queuedPrompt(line)
  if (prompt !== undefined) {
    const text = textOf(prompt)
    if (text.includes('<task-notification>')) {
      return {
        type: 'user',
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: text },
        parent_tool_use_id: null
      }
    }
    if (line['attachment'] && (line['attachment'] as Line)['commandMode'] === 'prompt') {
      return { type: 'user', uuid: line['uuid'], message: { role: 'user', content: prompt }, parent_tool_use_id: null }
    }
  }

  return null
}

/** The prompt of a queued_command attachment: a string or content blocks. */
function queuedPrompt(line: Line): string | unknown[] | undefined {
  if (line['type'] !== 'attachment' || !isObject(line['attachment'])) return undefined
  const attachment = line['attachment']
  if (attachment['type'] !== 'queued_command') return undefined
  const prompt = attachment['prompt']
  return typeof prompt === 'string' || Array.isArray(prompt) ? prompt : undefined
}

/** The text of a message content: the string itself, or its text blocks joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isObject)
    .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('\n')
}

/**
 * A queued prompt the CLI also wrote out as the very next user line. The
 * files seen so far never do, but showing a message twice is the worse miss.
 */
function repeatedByNext(line: Line, next: Line | undefined): boolean {
  if (!next || next['type'] !== 'user' || !isObject(next['message'])) return false
  const text = textOf(queuedPrompt(line))
  return text !== '' && textOf(next['message']['content']) === text
}

function blocksOf(line: Line): Line[] {
  const inner = line['message']
  if (!isObject(inner) || !Array.isArray(inner['content'])) return []
  return inner['content'].filter(isObject)
}

/** Subagent calls in this assistant line: Agent, or Task from older CLIs. */
function agentCalls(line: Line): string[] {
  if (line['type'] !== 'assistant') return []
  return blocksOf(line)
    .filter((b) => b['type'] === 'tool_use' && (b['name'] === 'Agent' || b['name'] === 'Task'))
    .map((b) => String(b['id'] ?? ''))
    .filter(Boolean)
}

/** tool_use id -> agentId, from the answers to the calls, then from each agent's meta.json. */
function agentIds(lines: Line[], subagentsDir: string): Map<string, string> {
  const ids = new Map<string, string>()
  for (const line of lines) {
    const result = line['toolUseResult']
    if (!isObject(result) || typeof result['agentId'] !== 'string') continue
    for (const block of blocksOf(line)) {
      if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        ids.set(block['tool_use_id'], result['agentId'])
      }
    }
  }

  let files: string[] = []
  try {
    files = readdirSync(subagentsDir).filter((f) => f.startsWith('agent-') && f.endsWith('.meta.json'))
  } catch {
    return ids
  }
  for (const file of files) {
    try {
      const meta: unknown = JSON.parse(readFileSync(join(subagentsDir, file), 'utf8'))
      const toolUseId = isObject(meta) ? meta['toolUseId'] : undefined
      if (typeof toolUseId === 'string' && !ids.has(toolUseId)) {
        ids.set(toolUseId, file.slice('agent-'.length, -'.meta.json'.length))
      }
    } catch {
      // An unreadable meta only costs that agent's steps.
    }
  }
  return ids
}

async function subagentSteps(subagentsDir: string, agentId: string, toolUseId: string): Promise<Line[]> {
  if (/[\\/]/.test(agentId)) return []
  const path = join(subagentsDir, `agent-${agentId}.jsonl`)
  if (!isFile(path)) return []
  try {
    const lines = (await readLines(path)).map(asMainLine)
    return chainOf(lines)
      .map(toMessage)
      .filter((m): m is Line => m !== null)
      .map((m) => ({ ...m, parent_tool_use_id: toolUseId }))
  } catch {
    return []
  }
}

/**
 * Inside a subagent's own file every line is a sidechain; within that file
 * they are its main line, so the chain is walked the same way.
 */
function asMainLine(line: Line): Line {
  return line['isSidechain'] === true ? { ...line, isSidechain: false } : line
}

/**
 * The session file as SDK stream messages, in conversation order, each
 * subagent's steps placed right after the call that started it.
 */
export async function readTranscript(path: string): Promise<unknown[]> {
  const lines = await readLines(path)
  const chain = chainOf(lines)
  const subagentsDir = join(dirname(path), basename(path, '.jsonl'), 'subagents')
  const hasAgents = chain.some((line) => agentCalls(line).length > 0)
  const ids = hasAgents ? agentIds(lines, subagentsDir) : new Map<string, string>()

  const messages: unknown[] = []
  for (const [index, line] of chain.entries()) {
    if (queuedPrompt(line) !== undefined && repeatedByNext(line, chain[index + 1])) continue
    const message = toMessage(line)
    if (message) messages.push(message)
    for (const toolUseId of agentCalls(line)) {
      const agentId = ids.get(toolUseId)
      if (agentId) messages.push(...(await subagentSteps(subagentsDir, agentId, toolUseId)))
    }
  }
  return messages
}

/** The conversation to show for a resumed session; empty when there is no file to read. */
export async function loadTranscript(
  sessionId: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<unknown[]> {
  try {
    const path = findTranscript(sessionId, cwd, claudeConfigDir(env, home))
    return path ? await readTranscript(path) : []
  } catch {
    return []
  }
}
