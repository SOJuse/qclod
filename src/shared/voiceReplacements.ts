import type { VoiceReplacement } from './voice'

const R = (from: string, to: string): VoiceReplacement => ({ from, to })

/** The standard dictionary (decision 10: settings keep `null` until the person edits it). */
export const DEFAULT_REPLACEMENTS: readonly VoiceReplacement[] = Object.freeze([
  R('клод', 'Claude'),
  // Whisper writes «Claud» even with «Claude» in its prompt (S5-R1).
  R('claud', 'Claude'),
  R('тайп скрипт', 'TypeScript'),
  R('джава скрипт', 'JavaScript'),
  R('гит пуш', 'git push'),
  R('гид пуш', 'git push'),
  R('гит пул', 'git pull'),
  R('гид пул', 'git pull'),
  R('гит хаб', 'GitHub'),
  R('гит', 'git'),
  R('реакт', 'React'),
  R('электрон', 'Electron'),
  R('эн пи эм', 'npm'),
  R('мпм', 'npm'),
  R('джейсон', 'JSON'),
  R('джисон', 'JSON'),
  R('докер', 'Docker'),
  R('doker', 'Docker'),
  R('пул реквест', 'pull request'),
  R('пулл реквест', 'pull request'),
  R('эй пи ай', 'API'),
  R('апи', 'API'),
  R('питон', 'Python'),
  R('пайтон', 'Python'),
  R('линукс', 'Linux'),
  R('ви эс код', 'VS Code'),
  R('вс код', 'VS Code')
])

/** Frequent Russian case endings: «Клода», «реактом», «в докере». Longest first. */
const ENDINGS = ['ами', 'ом', 'ов', 'ам', 'ах', 'ой', 'а', 'у', 'е', 'ы', 'ю', 'я']

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

/** One word-group pattern: ё = е, separators inside optional, every other character literal. */
function patternOf(from: string): string | null {
  const parts = from
    .trim()
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((p) => p.length > 0)
  if (parts.length === 0) return null
  return parts
    .map((part) =>
      Array.from(part)
        .map((ch) => (ch === 'е' || ch === 'ё' ? '[её]' : escapeRegExp(ch)))
        .join('')
    )
    .join('[\\s-]*')
}

const BEFORE = '(?<![\\p{L}\\p{N}])'
const AFTER = '(?![\\p{L}\\p{N}])'

/**
 * Whole words, any case, ё = е; a space or hyphen inside a `from` is optional;
 * an optional Russian ending follows. One pass over the text, so a result is
 * never replaced again; longer `from` goes first («гит пуш» before «гит»).
 */
export function applyReplacements(text: string, entries: readonly VoiceReplacement[]): string {
  const usable: Array<{ pattern: string; length: number; to: string }> = []
  for (const entry of entries) {
    if (typeof entry?.from !== 'string' || typeof entry.to !== 'string') continue
    const pattern = patternOf(entry.from)
    if (pattern !== null) usable.push({ pattern, length: entry.from.trim().length, to: entry.to })
  }
  if (usable.length === 0 || text === '') return text
  usable.sort((a, b) => b.length - a.length)
  const ending = `(?:${ENDINGS.join('|')})?`
  const source = `${BEFORE}(?:${usable.map((u) => `(${u.pattern})`).join('|')})${ending}${AFTER}`
  const re = new RegExp(source, 'giu')
  return text.replace(re, (...args: unknown[]) => {
    for (let i = 0; i < usable.length; i++) {
      if (args[i + 1] !== undefined) return usable[i].to
    }
    return args[0] as string
  })
}
