import { readdirSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export class AgentNotFoundError extends Error {
  constructor(readonly requested: string) {
    super(
      `Не удалось найти исполняемый файл агента: "${requested}". ` +
        `Укажите полный путь к claude.exe в настройках Qclod.`
    )
    this.name = 'AgentNotFoundError'
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Looks for `base` (plus each PATHEXT extension, in order) inside `dir`.
 * Matching is case-insensitive — PATHEXT is upper case while files on disk are
 * usually lower case — but the name that comes back is the real one on disk.
 */
function findIn(dir: string, base: string, exts: string[]): string | undefined {
  const entries = listFiles(dir)
  if (entries.length === 0) return undefined
  const candidates = extname(base) !== '' ? [base] : [base, ...exts.map((ext) => base + ext)]

  for (const candidate of candidates) {
    const wanted = candidate.toLowerCase()
    const actual = entries.find((entry) => entry.toLowerCase() === wanted)
    if (actual === undefined) continue
    const full = join(dir, actual)
    if (isFile(full)) return full
  }
  return undefined
}

/**
 * ConPTY needs a real path to an executable: unlike a shell, node-pty does not
 * search PATH/PATHEXT, and `spawn('claude')` fails with "File not found" even
 * when `claude` runs fine from a terminal. Probe note 1, 2026-11-07.
 */
export function resolveExecutable(requested: string, env: NodeJS.ProcessEnv): string {
  const name = requested?.trim() ?? ''
  if (name === '') throw new AgentNotFoundError(requested ?? '')

  const exts = (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .split(delimiter)
    .map((e) => e.trim())
    .filter(Boolean)

  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const full = resolve(name)
    const found = findIn(dirname(full), basename(full), exts)
    if (found) return found
    throw new AgentNotFoundError(requested)
  }

  for (const entry of (env['PATH'] ?? '').split(delimiter)) {
    const dir = entry.replace(/^"|"$/g, '')
    if (!dir) continue
    const found = findIn(dir, name, exts)
    if (found) return found
  }

  throw new AgentNotFoundError(requested)
}
