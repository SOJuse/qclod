import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'

export class AgentNotFoundError extends Error {
  constructor(
    readonly requested: string,
    /** A .cmd/.bat that was found but could not be turned into something runnable. */
    readonly shim?: string
  ) {
    super(
      shim
        ? `Найден "${shim}", но это .cmd-обёртка: её нельзя запустить напрямую, ` +
            `а claude.exe или cli.js, на которые она указывает, не нашлись. ` +
            `Укажите полный путь к claude.exe в настройках Qclod.`
        : `Не удалось найти исполняемый файл агента: "${requested}". ` +
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

const isShim = (path: string): boolean => /\.(cmd|bat)$/i.test(path)

/**
 * The file an npm `.cmd` wrapper (cmd-shim) actually runs, or null.
 *
 * The wrapper is read rather than guessed from %APPDATA%\npm, so a custom npm
 * prefix and paths with spaces work the same. It names its target relative to
 * its own folder as `"%dp0%\…"`; the node.exe it may run that target with is
 * skipped, and the last remaining path is the target. Today that is
 * `bin\claude.exe`; older packages point at `cli.js`, which the SDK runs
 * through node itself.
 */
export function unwrapShim(path: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }

  const targets = [...text.matchAll(/%dp0%\\([^"\r\n]*)/gi)]
    .map((m) => m[1]!.trim())
    .filter((rel) => rel !== '' && !/node\.exe$/i.test(rel))
  const last = targets.at(-1)
  if (last === undefined) return null

  const full = resolve(dirname(path), last)
  return /\.(exe|js)$/i.test(full) && isFile(full) ? full : null
}

/**
 * Looks for `base` inside `dir`: as given when it has an extension, otherwise
 * with each of `exts` in order. Matching is case-insensitive — PATHEXT is upper
 * case while files on disk are usually lower case — but the name that comes
 * back is the real one on disk.
 */
function findIn(dir: string, base: string, exts: string[]): string | undefined {
  const entries = listFiles(dir)
  const candidates = extname(base) !== '' ? [base] : exts.map((ext) => base + ext)

  for (const candidate of candidates) {
    const wanted = candidate.toLowerCase()
    const actual = entries.find((entry) => entry.toLowerCase() === wanted)
    if (actual === undefined) continue
    const full = join(dir, actual)
    if (isFile(full)) return full
  }

  // A directory that cannot be listed is not a directory without the file in
  // it. WindowsApps — where Windows keeps winget and other app aliases —
  // refuses to be read but answers about a named file perfectly well, so the
  // candidates are tried directly before giving up.
  for (const candidate of candidates) {
    const full = join(dir, candidate)
    if (isFile(full)) return full
  }
  return undefined
}

/**
 * Extensions to try for a bare name, best first.
 *
 * On Windows only what starts without a shell is worth finding: .exe and .com
 * come first whatever PATHEXT says, then the rest of PATHEXT in its order
 * (a .cmd/.bat found that way is unwrapped). The bare name itself is never a
 * candidate there — for npm it is a sh script, and spawning it is ENOENT.
 */
function candidateExtensions(env: NodeJS.ProcessEnv): string[] {
  const pathext = (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
    .split(delimiter)
    .map((e) => e.trim())
    .filter(Boolean)
  if (process.platform !== 'win32') return ['', ...pathext]

  const has = (ext: string): boolean => pathext.some((e) => e.toLowerCase() === ext)
  const first = ['.exe', ...(has('.com') ? ['.com'] : [])]
  return [...first, ...pathext.filter((e) => !first.includes(e.toLowerCase()))]
}

/**
 * The SDK spawns the agent directly rather than through a shell, so it needs a
 * real path to an executable: the spawn does not search PATH/PATHEXT, and `spawn('claude')` fails with "File not found" even
 * when `claude` runs fine from a terminal. Probe note 1, 2026-11-07. Nor can it
 * start a .cmd (EINVAL), so npm's wrapper is replaced by the file it runs.
 */
export function resolveExecutable(requested: string, env: NodeJS.ProcessEnv): string {
  const name = requested?.trim() ?? ''
  if (name === '') throw new AgentNotFoundError(requested ?? '')

  const exts = candidateExtensions(env)
  let unusableShim: string | undefined

  const accept = (found: string | undefined): string | undefined => {
    if (found === undefined || process.platform !== 'win32' || !isShim(found)) return found
    const target = unwrapShim(found)
    if (target === null) unusableShim ??= found
    return target ?? undefined
  }

  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    const full = resolve(name)
    const found = accept(findIn(dirname(full), basename(full), exts))
    if (found) return found
    throw new AgentNotFoundError(requested, unusableShim)
  }

  for (const entry of (env['PATH'] ?? '').split(delimiter)) {
    const dir = entry.replace(/^"|"$/g, '')
    if (!dir) continue
    const found = accept(findIn(dir, name, exts))
    if (found) return found
  }

  throw new AgentNotFoundError(requested, unusableShim)
}
