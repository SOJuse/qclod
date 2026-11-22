import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The texts of a session transcript (`~/.claude/projects/<папка>/<id>.jsonl`),
 * for «Собрать мои шаблоны» and the search over past conversations.
 *
 * Read only: every file is opened with `flags: 'r'` and nothing here writes.
 * Streamed, line by line, with a cap on a line's length: a pasted image is a
 * line of megabytes of base64, and it is dropped while it streams past, never
 * held whole or parsed. A broken line — and the last one the CLI is still
 * writing — is skipped.
 */

/** A line longer than this is skipped without JSON.parse. */
export const MAX_LINE_CHARS = 1_000_000

export interface TranscriptText {
  role: 'user' | 'assistant'
  text: string
  /** Typed by the person: not a tool result, a command's output, a notice or a summary. */
  human: boolean
  /** The line's timestamp; 0 when it has none. */
  at: number
}

export interface TranscriptMeta {
  cwd: string | null
  firstPrompt: string | null
}

type Line = Record<string, unknown>

function isObject(value: unknown): value is Line {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `<command-name>`, `<local-command-stdout>`, `<system-reminder>`…: the CLI's, not the person's. */
const TAGGED = /^<[a-z][a-z-]*>/

function timeOf(line: Line): number {
  const t = typeof line['timestamp'] === 'string' ? Date.parse(line['timestamp']) : NaN
  return Number.isFinite(t) ? t : 0
}

/** A human-origin mark, when the line has one: only `human` counts. */
function originOk(origin: unknown): boolean {
  return origin === undefined || (isObject(origin) && origin['kind'] === 'human')
}

/** The person's text of a `user` line, or null when the line is not theirs. */
function humanText(line: Line): string | null {
  if (line['isSidechain'] === true || line['isMeta'] === true || line['isCompactSummary'] === true) return null
  if (line['toolUseResult'] !== undefined || !originOk(line['origin'])) return null
  const message = line['message']
  if (!isObject(message)) return null
  const content = message['content']
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (!isObject(block)) continue
      // A tool's answer rides in a user line: none of it is the person's.
      if (block['type'] === 'tool_result') return null
      if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
    }
    text = parts.join('\n')
  } else {
    return null
  }
  text = text.trim()
  if (text === '' || TAGGED.test(text)) return null
  return text
}

/** A prompt the person typed while a turn ran, delivered as an attachment. */
function queuedText(line: Line): string | null {
  if (line['isSidechain'] === true) return null
  const a = line['attachment']
  if (!isObject(a) || a['type'] !== 'queued_command') return null
  if (!isObject(a['origin']) || a['origin']['kind'] !== 'human') return null
  if (typeof a['prompt'] !== 'string') return null
  const text = a['prompt'].trim()
  if (text === '' || TAGGED.test(text)) return null
  return text
}

/** An answer's text blocks — not its thinking, not its tool calls. */
function assistantText(line: Line): string | null {
  if (line['isSidechain'] === true) return null
  const message = line['message']
  if (!isObject(message) || !Array.isArray(message['content'])) return null
  const parts: string[] = []
  for (const block of message['content']) {
    if (isObject(block) && block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
  }
  const text = parts.join('\n').trim()
  return text === '' ? null : text
}

function textOf(line: Line): TranscriptText | null {
  const at = timeOf(line)
  switch (line['type']) {
    case 'user': {
      const text = humanText(line)
      return text === null ? null : { role: 'user', text, human: true, at }
    }
    case 'attachment': {
      const text = queuedText(line)
      return text === null ? null : { role: 'user', text, human: true, at }
    }
    case 'assistant': {
      const text = assistantText(line)
      return text === null ? null : { role: 'assistant', text, human: false, at }
    }
    default:
      return null
  }
}

/**
 * The file's lines, each at most MAX_LINE_CHARS long: a longer one is dropped
 * as it streams, its pieces never joined. The last line counts only when the
 * file ends with a newline — without one, the CLI is still writing it.
 */
async function* boundedLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8', flags: 'r' })
  let pending = ''
  let skipping = false
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      let from = 0
      for (;;) {
        const nl = chunk.indexOf('\n', from)
        if (nl === -1) {
          if (!skipping) {
            pending += chunk.slice(from)
            if (pending.length > MAX_LINE_CHARS) {
              pending = ''
              skipping = true
            }
          }
          break
        }
        if (!skipping) {
          const line = pending + chunk.slice(from, nl)
          if (line.length <= MAX_LINE_CHARS) yield line
        }
        pending = ''
        skipping = false
        from = nl + 1
      }
    }
    // A last line with no newline is unfinished: the CLI writes the newline with it.
  } finally {
    stream.destroy()
  }
}

/** Потоково, только чтение; битые строки пропускаются; сабагентские (isSidechain) — нет в выдаче. */
export async function* readTranscriptTexts(
  path: string,
  onMeta?: (m: TranscriptMeta) => void
): AsyncGenerator<TranscriptText> {
  const meta: TranscriptMeta = { cwd: null, firstPrompt: null }
  try {
    for await (const raw of boundedLines(path)) {
      if (raw.trim() === '') continue
      let line: unknown
      try {
        line = JSON.parse(raw)
      } catch {
        continue
      }
      if (!isObject(line)) continue
      if (meta.cwd === null && typeof line['cwd'] === 'string' && line['cwd'] !== '' && line['isSidechain'] !== true) {
        meta.cwd = line['cwd']
      }
      const text = textOf(line)
      if (!text) continue
      if (text.human && meta.firstPrompt === null) meta.firstPrompt = text.text
      yield text
    }
  } finally {
    onMeta?.(meta)
  }
}

export interface SessionFile {
  path: string
  projectKey: string
  sessionId: string
  mtimeMs: number
  size: number
}

/** Файлы сессий `<configDir>/projects/<папка>/<id>.jsonl` (без подпапок сабагентов), новые сверху. */
export async function listSessionFiles(configDir: string): Promise<SessionFile[]> {
  const projects = join(configDir, 'projects')
  let folders: string[]
  try {
    folders = (await readdir(projects, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  const out: SessionFile[] = []
  for (const folder of folders) {
    let entries
    try {
      entries = await readdir(join(projects, folder), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(projects, folder, entry.name)
      try {
        const s = await stat(path)
        out.push({ path, projectKey: folder, sessionId: entry.name.slice(0, -'.jsonl'.length), mtimeMs: s.mtimeMs, size: s.size })
      } catch {
        // Gone between the listing and the stat.
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
}
