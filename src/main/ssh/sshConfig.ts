/**
 * The servers a person already named in ~/.ssh/config (stage 6, I3): every
 * `Host` that is a plain name, not a pattern. Qclod only reads the file; ssh
 * itself applies the rest of it on every connect.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

const MAX_INCLUDE_DEPTH = 5

/** `key value`, `key=value`, `key = value`; a `#` starts a comment outside quotes. */
function splitLine(line: string): { key: string; words: string[] } | null {
  const words: string[] = []
  let current = ''
  let inQuote = false
  let hasWord = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      inQuote = !inQuote
      hasWord = true
      continue
    }
    if (!inQuote && ch === '#') break
    if (!inQuote && (ch === ' ' || ch === '\t' || (ch === '=' && words.length === 0))) {
      if (hasWord) words.push(current)
      current = ''
      hasWord = false
      continue
    }
    current += ch
    hasWord = true
  }
  if (hasWord) words.push(current)
  if (words.length === 0) return null
  return { key: words[0]!.toLowerCase(), words: words.slice(1) }
}

function isPlainName(name: string): boolean {
  return name !== '' && !/[*?!]/.test(name)
}

/**
 * Host names without `*`, `?` or `!`, in order, each once. `Include` is
 * followed through `readInclude` (the text of every file the pattern names),
 * at most 5 levels deep.
 */
export function configHosts(text: string, readInclude: (pattern: string) => string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (body: string, depth: number): void => {
    for (const raw of body.split(/\r?\n/)) {
      const line = splitLine(raw.trim())
      if (!line) continue
      if (line.key === 'host') {
        for (const name of line.words) {
          if (!isPlainName(name) || seen.has(name)) continue
          seen.add(name)
          out.push(name)
        }
      } else if (line.key === 'include' && depth < MAX_INCLUDE_DEPTH) {
        for (const pattern of line.words) {
          for (const included of readInclude(pattern)) walk(included, depth + 1)
        }
      }
    }
  }
  walk(text, 0)
  return out
}

/** `*` and `?` in the last part of a path; folders are taken literally. */
function globFiles(pattern: string): string[] {
  const dir = dirname(pattern)
  const leaf = basename(pattern)
  if (!/[*?]/.test(leaf)) return [pattern]
  const re = new RegExp(
    '^' + leaf.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  )
  try {
    return readdirSync(dir)
      .filter((name) => re.test(name))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/** The hosts of the person's ~/.ssh/config; nothing when there is none. */
export function readUserConfigHosts(home: string = homedir()): string[] {
  const sshDir = join(home, '.ssh')
  let text: string
  try {
    text = readFileSync(join(sshDir, 'config'), 'utf8')
  } catch {
    return []
  }
  const readInclude = (pattern: string): string[] => {
    const expanded = pattern.startsWith('~/') ? join(home, pattern.slice(2)) : pattern
    const full = isAbsolute(expanded) ? expanded : join(sshDir, expanded)
    const texts: string[] = []
    for (const file of globFiles(full)) {
      try {
        texts.push(readFileSync(file, 'utf8'))
      } catch {
        // A file that cannot be read adds no hosts.
      }
    }
    return texts
  }
  return configHosts(text, readInclude)
}
