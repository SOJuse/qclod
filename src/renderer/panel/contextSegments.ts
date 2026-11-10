import type { ContextInfo } from '../../shared/types'

export interface Segment {
  name: string
  tokens: number
  share: number
  fill: 'seg-1' | 'seg-2' | 'seg-3' | 'seg-4' | 'seg-5' | 'seg-6' | 'seg-free' | 'seg-buffer'
}

const USED_FILLS = ['seg-1', 'seg-2', 'seg-3', 'seg-4', 'seg-5', 'seg-6'] as const

/** The CLI's own names for what fills the window, in Russian. Unknown names stay as they came. */
const NAMES: Record<string, string> = {
  'system prompt': 'Системный промпт',
  'system tools': 'Инструменты',
  'mcp tools': 'Инструменты MCP',
  'custom agents': 'Агенты',
  'memory files': 'Файлы памяти',
  skills: 'Навыки',
  messages: 'Сообщения'
}

function russian(name: string): string {
  return NAMES[name.trim().toLowerCase().replace(/_/g, ' ')] ?? name
}

/**
 * The parts of the context bar, in the CLI's order: what is in the window,
 * then the compaction reserve, then what is left. Shares add up to 1.
 */
export function contextSegments(categories: ContextInfo['categories'], max: number): Segment[] {
  const used = categories.filter((c) => (c.kind === undefined || c.kind === 'used') && c.tokens > 0)
  const parts: Array<Omit<Segment, 'share'>> = used.slice(0, 6).map((c, i) => ({
    name: russian(c.name),
    tokens: c.tokens,
    fill: USED_FILLS[i]
  }))
  const rest = used.slice(6)
  if (rest.length > 0) {
    parts.push({ name: 'Другое', tokens: rest.reduce((a, c) => a + c.tokens, 0), fill: 'seg-6' })
  }

  const buffer = categories.filter((c) => c.kind === 'buffer').reduce((a, c) => a + c.tokens, 0)
  if (buffer > 0) parts.push({ name: 'Резерв сжатия', tokens: buffer, fill: 'seg-buffer' })

  const freeRows = categories.filter((c) => c.kind === 'free')
  const free = freeRows.length > 0
    ? freeRows.reduce((a, c) => a + c.tokens, 0)
    : Math.max(0, max - parts.reduce((a, p) => a + p.tokens, 0))
  if (free > 0) parts.push({ name: 'Свободно', tokens: free, fill: 'seg-free' })

  const total = parts.reduce((a, p) => a + p.tokens, 0)
  return total === 0 ? [] : parts.map((p) => ({ ...p, share: p.tokens / total }))
}
