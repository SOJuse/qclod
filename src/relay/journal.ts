import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'
import { JOURNAL_KINDS, type JournalKind, type JournalRecord } from '../shared/relayProtocol'

export const JOURNAL_FILE = 'journal.jsonl'
export const JOURNAL_MAX_BYTES = 32 * 1024 * 1024

/** Folders 0700, files 0600, whatever they were made with before. No-op on Windows. */
export function privateMode(path: string, mode: number): void {
  if (process.platform === 'win32') return
  try {
    chmodSync(path, mode)
  } catch {
    // Not ours to change; the open/mkdir mode stands.
  }
}

function parseRecord(line: string): JournalRecord | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const q = r['q']
  if (typeof q !== 'number' || !Number.isSafeInteger(q) || q < 1) return null
  if (typeof r['at'] !== 'number' || !(JOURNAL_KINDS as readonly unknown[]).includes(r['k'])) return null
  return { q, at: r['at'], k: r['k'] as JournalKind, d: r['d'] }
}

interface Line {
  record: JournalRecord
  text: string
}

/** Every whole record of the file, and the byte length they take; a broken tail is not counted. */
function readLines(file: string): { lines: Line[]; bytes: number; size: number } {
  let content: Buffer
  try {
    content = readFileSync(file)
  } catch {
    return { lines: [], bytes: 0, size: 0 }
  }
  const lines: Line[] = []
  let bytes = 0
  let start = 0
  for (;;) {
    const end = content.indexOf(0x0a, start)
    if (end < 0) break
    const text = content.subarray(start, end).toString('utf8')
    start = end + 1
    const record = parseRecord(text)
    // A line that is no record is skipped; the numbering is the records' own.
    if (record && (lines.length === 0 || record.q > lines[lines.length - 1]!.record.q)) {
      lines.push({ record, text })
    }
    bytes = start
  }
  // What follows the last newline was cut off mid-write: it is no record.
  return { lines, bytes, size: content.length }
}

/**
 * One session's journal: everything a client may have to catch up on, numbered
 * 1, 2, 3… Appends are synchronous lines in journal.jsonl, never a reread of
 * the file. Past `maxBytes` the file is rewritten with the newer half of its
 * records, and `firstSeq` moves on: a client further behind sees a gap.
 */
export class Journal {
  private fd: number
  private bytes: number
  private first: number
  private last: number
  private readonly file: string
  private readonly maxBytes: number
  private readonly now: () => number

  private constructor(dir: string, opts: { maxBytes?: number; now?: () => number }) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    privateMode(dir, 0o700)
    this.file = join(dir, JOURNAL_FILE)
    this.maxBytes = opts.maxBytes ?? JOURNAL_MAX_BYTES
    this.now = opts.now ?? Date.now
    const { lines, bytes, size } = readLines(this.file)
    // A cut-off tail goes, so the next line does not land glued to it.
    if (size > bytes) truncateSync(this.file, bytes)
    this.fd = openSync(this.file, 'a', 0o600)
    privateMode(this.file, 0o600)
    this.bytes = bytes
    this.first = lines[0]?.record.q ?? 1
    this.last = lines[lines.length - 1]?.record.q ?? 0
  }

  static open(dir: string, opts: { maxBytes?: number; now?: () => number } = {}): Journal {
    return new Journal(dir, opts)
  }

  get firstSeq(): number {
    return this.first
  }

  get lastSeq(): number {
    return this.last
  }

  append(k: JournalKind, d: unknown): JournalRecord {
    const record: JournalRecord = { q: this.last + 1, at: this.now(), k, d }
    const line = Buffer.from(JSON.stringify(record) + '\n', 'utf8')
    writeSync(this.fd, line)
    this.bytes += line.length
    if (this.last === 0) this.first = record.q
    this.last = record.q
    if (this.bytes > this.maxBytes) this.compact()
    return record
  }

  /** gap — records after `after` are already gone (it is before firstSeq − 1). */
  readAfter(after: number): { records: JournalRecord[]; gap: boolean } {
    const gap = after < this.first - 1
    if (after >= this.last) return { records: [], gap }
    const { lines } = readLines(this.file)
    return { records: lines.filter((l) => l.record.q > after).map((l) => l.record), gap }
  }

  close(): void {
    try {
      closeSync(this.fd)
    } catch {
      // Already closed.
    }
  }

  /** Keeps the newer half of the records: written aside, then put in place. */
  private compact(): void {
    const { lines } = readLines(this.file)
    let kept = lines.slice(Math.floor(lines.length / 2))
    let text = kept.map((l) => l.text + '\n').join('')
    // One huge record can outweigh the half: drop from the front until it fits.
    while (kept.length > 1 && Buffer.byteLength(text, 'utf8') > this.maxBytes) {
      kept = kept.slice(Math.ceil(kept.length / 2))
      text = kept.map((l) => l.text + '\n').join('')
    }
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, text, { mode: 0o600 })
    // Windows will not rename over an open file.
    closeSync(this.fd)
    renameSync(tmp, this.file)
    this.fd = openSync(this.file, 'a', 0o600)
    this.bytes = Buffer.byteLength(text, 'utf8')
    this.first = kept[0]?.record.q ?? this.last + 1
  }
}
