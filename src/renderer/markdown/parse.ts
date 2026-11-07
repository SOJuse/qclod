/**
 * The markdown the agent already writes, turned into something we can render.
 *
 * Claude formats its answers in markdown whether or not anyone asks it to —
 * headings, lists, fenced code, tables. Showing that as raw text is why the
 * ribbon reads as a wall of asterisks and backticks.
 *
 * Written here rather than pulled from a library for one reason that matters:
 * this produces a tree of plain data, which React renders as elements. No HTML
 * string ever exists, so no `dangerouslySetInnerHTML`, so nothing the agent
 * writes — or that a web page it read told it to write — can become markup.
 */

export type Span =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; spans: Span[] }
  | { kind: 'em'; spans: Span[] }
  | { kind: 'strike'; spans: Span[] }
  | { kind: 'link'; href: string; spans: Span[] }

export interface ListItem {
  spans: Span[]
  /** A nested list under this item, already parsed. */
  children: Block[]
  /** `- [x]` renders as a checkbox rather than a bullet. */
  checked?: boolean
}

export type Block =
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }
  | { kind: 'table'; head: Span[][]; rows: Span[][][] }

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const TASK = /^\[([ xX])\]\s+(.*)$/

function indentOf(line: string): number {
  const match = /^\s*/.exec(line)
  return match ? match[0].replace(/\t/g, '    ').length : 0
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/** Markdown is line-based above the sentence, so the block pass is too. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  return parseBlocks(lines)
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    if (line.trim() === '') {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[2]!
      const language = fence[3] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker.slice(0, 3))) {
        body.push(lines[i]!)
        i++
      }
      // An unterminated fence still renders as code: the agent is mid-stream.
      if (i < lines.length) i++
      blocks.push({ kind: 'code', language, code: body.join('\n') })
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        spans: parseInline(heading[2]!.replace(/\s+#+\s*$/, ''))
      })
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(QUOTE.exec(lines[i]!)![1]!)
        i++
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(body) })
      continue
    }

    // A table needs its divider row to be a table at all.
    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      const head = splitRow(line).map(parseInline)
      i += 2
      const rows: Span[][][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!).map(parseInline))
        i++
      }
      blocks.push({ kind: 'table', head, rows })
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i)
      blocks.push(list)
      i = next
      continue
    }

    // Everything else is a paragraph, running until a blank line or a line
    // that starts a block of its own.
    const paragraph: string[] = []
    while (i < lines.length) {
      const current = lines[i]!
      if (current.trim() === '') break
      if (
        FENCE.test(current) ||
        HEADING.test(current) ||
        QUOTE.test(current) ||
        RULE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current)
      ) {
        break
      }
      paragraph.push(current.trim())
      i++
    }
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', spans: parseInline(paragraph.join('\n')) })
    }
  }

  return blocks
}

/** Reads one list, following indentation into nested lists. */
function parseList(lines: string[], start: number): [Block, number] {
  const first = lines[start]!
  const ordered = ORDERED.test(first) && !BULLET.test(first)
  const baseIndent = indentOf(first)
  const startNumber = ordered ? Number(ORDERED.exec(first)![2]) : 1

  const items: ListItem[] = []
  let i = start

  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      // A blank line ends the list unless the next line continues it.
      const next = lines[i + 1]
      if (next === undefined) break
      if (!BULLET.test(next) && !ORDERED.test(next)) break
      if (indentOf(next) < baseIndent) break
      i++
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = ORDERED.exec(line)
    if (!bullet && !numbered) break

    const indent = indentOf(line)
    if (indent < baseIndent) break
    if (indent > baseIndent) {
      // Deeper: it belongs to the item above, as a nested list.
      const [nested, next] = parseList(lines, i)
      const owner = items[items.length - 1]
      if (owner) owner.children.push(nested)
      else items.push({ spans: [], children: [nested] })
      i = next
      continue
    }

    const raw = bullet ? bullet[2]! : numbered![3]!
    const task = TASK.exec(raw)
    items.push({
      spans: parseInline(task ? task[2]! : raw),
      children: [],
      ...(task ? { checked: task[1]!.toLowerCase() === 'x' } : {})
    })
    i++
  }

  return [{ kind: 'list', ordered, start: startNumber, items }, i]
}

// ------------------------------------------------------------------ inline

const LINK = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/
const BARE_URL = /^(https?:\/\/[^\s<>()]+[^\s<>().,!?;:])/

/**
 * Spans inside a line. Code wins over everything else — inside backticks the
 * asterisks are asterisks, which is exactly why the agent put them there.
 */
export function parseInline(source: string): Span[] {
  const spans: Span[] = []
  let text = ''
  let i = 0

  const flush = (): void => {
    if (text !== '') {
      spans.push({ kind: 'text', text })
      text = ''
    }
  }

  while (i < source.length) {
    const rest = source.slice(i)
    const char = source[i]!

    if (char === '`') {
      const ticks = /^`+/.exec(rest)![0]
      const close = source.indexOf(ticks, i + ticks.length)
      if (close !== -1) {
        flush()
        spans.push({ kind: 'code', text: source.slice(i + ticks.length, close).trim() })
        i = close + ticks.length
        continue
      }
    }

    if (char === '\\' && i + 1 < source.length) {
      text += source[i + 1]
      i += 2
      continue
    }

    if (char === '[') {
      const link = LINK.exec(rest)
      if (link) {
        flush()
        spans.push({ kind: 'link', href: link[2]!, spans: parseInline(link[1]!) })
        i += link[0].length
        continue
      }
    }

    if (char === 'h') {
      const url = BARE_URL.exec(rest)
      if (url) {
        flush()
        spans.push({ kind: 'link', href: url[1]!, spans: [{ kind: 'text', text: url[1]! }] })
        i += url[1]!.length
        continue
      }
    }

    const emphasis = readEmphasis(source, i)
    if (emphasis) {
      flush()
      spans.push(emphasis.span)
      i = emphasis.next
      continue
    }

    text += char
    i++
  }

  flush()
  return spans
}

interface Emphasis {
  span: Span
  next: number
}

function readEmphasis(source: string, at: number): Emphasis | null {
  for (const [marker, kind] of [
    ['***', 'strong'],
    ['___', 'strong'],
    ['**', 'strong'],
    ['__', 'strong'],
    ['~~', 'strike'],
    ['*', 'em'],
    ['_', 'em']
  ] as const) {
    if (!source.startsWith(marker, at)) continue

    // `snake_case_word` is not emphasis: an underscore between word characters
    // belongs to the identifier, not to markdown.
    if (marker === '_' || marker === '__') {
      const before = at > 0 ? source[at - 1]! : ' '
      if (/\w/.test(before)) continue
    }

    const close = source.indexOf(marker, at + marker.length)
    if (close === -1) continue
    const inner = source.slice(at + marker.length, close)
    if (inner.trim() === '') continue

    const spans = parseInline(inner)
    const span: Span =
      kind === 'strike'
        ? { kind: 'strike', spans }
        : kind === 'strong'
          ? { kind: 'strong', spans }
          : { kind: 'em', spans }
    return { span, next: close + marker.length }
  }
  return null
}
