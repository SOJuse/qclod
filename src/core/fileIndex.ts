import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { filterPaths } from '../shared/fuzzy'

export { filterPaths }

const DEFAULT_LIMIT = 8000

/** Never worth indexing, .gitignore or not. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.hg', '.svn'])

interface GitignoreRule {
  negated: boolean
  dirOnly: boolean
  anchored: boolean
  regex: RegExp
}

function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

function parseGitignore(contents: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const raw of contents.split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const negated = line.startsWith('!')
    if (negated) line = line.slice(1)

    const dirOnly = line.endsWith('/')
    if (dirOnly) line = line.slice(0, -1)

    const anchored = line.startsWith('/')
    if (anchored) line = line.slice(1)

    if (line === '') continue
    rules.push({ negated, dirOnly, anchored, regex: globToRegExp(line) })
  }
  return rules
}

function isIgnored(relPath: string, isDir: boolean, rules: GitignoreRule[]): boolean {
  let ignored = false
  const segments = relPath.split('/')

  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue

    // An unanchored pattern matches at any depth; an anchored one only at root.
    const candidates = rule.anchored
      ? [relPath]
      : [relPath, ...segments.map((_, i) => segments.slice(i).join('/'))]

    if (candidates.some((candidate) => rule.regex.test(candidate))) {
      ignored = !rule.negated
    }
  }
  return ignored
}

export interface IndexOptions {
  limit?: number
}

/**
 * Lists the project's files for `@`-mentions: paths relative to `cwd`, with
 * forward slashes, honouring .gitignore. Capped so a huge tree cannot stall
 * the main process.
 */
export async function buildFileIndex(cwd: string, options: IndexOptions = {}): Promise<string[]> {
  const limit = options.limit ?? DEFAULT_LIMIT
  const rules = await readRules(cwd)
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    if (out.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (out.length >= limit) return
      if (ALWAYS_SKIP.has(entry.name)) continue

      const full = join(dir, entry.name)
      const rel = relative(cwd, full).split('\\').join('/')
      if (isIgnored(rel, entry.isDirectory(), rules)) continue

      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(rel)
    }
  }

  await walk(cwd)
  return out.slice(0, limit)
}

async function readRules(cwd: string): Promise<GitignoreRule[]> {
  try {
    return parseGitignore(await readFile(join(cwd, '.gitignore'), 'utf8'))
  } catch {
    return []
  }
}
