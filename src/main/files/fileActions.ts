import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import { cmdShellArgs, quoteArg } from '../setup/install'

/**
 * What a click on a path in the chat may do. A path comes from the agent's
 * text, so nothing here ever starts a program.
 *
 * Only types whose default Windows program shows them without running
 * anything or reaching a server are opened; everything else (executables,
 * scripts, shortcuts, .js, .py, .html, .svg, disk images, .rdp, .search-ms,
 * unknown types, no extension) is shown in Explorer, where the user decides.
 * A denylist would miss the next handler someone installs.
 *
 * Office and OpenDocument files and .rtf are shown, not opened: they can pull
 * a remote template or carry an OLE exploit, and a file the agent wrote has
 * no Mark of the Web, so Office would not open it in Protected View. So are
 * .csv and .tsv: their default program is usually Excel, which runs their
 * formulas just the same.
 */
const OPENABLE = new Set([
  // text
  '.txt', '.md', '.markdown', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.conf', '.log', '.diff', '.patch',
  // source no default program runs
  '.ts', '.tsx', '.mts', '.cts', '.css', '.scss', '.less', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.rs', '.go', '.java', '.cs',
  // images (no .svg: a browser runs its scripts)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  // documents
  '.pdf'
])

/** Windows drops trailing dots and spaces, so `setup.exe.` runs setup.exe. */
function typeOf(path: string): string {
  return extname(path.replace(/[. ]+$/, '')).toLowerCase()
}

function isOpenableType(path: string): boolean {
  return OPENABLE.has(typeOf(path))
}

/** Anything not known to be inert counts as runnable. */
export function isRunnable(path: string): boolean {
  return !isOpenableType(path)
}

type ShellEntry = { action: 'open' | 'reveal' | 'editor'; path: string; line?: number }

/**
 * e2e cannot watch Explorer open, so the e2e build records the action
 * instead. A release build has no such branch (buildFlags.d.ts).
 */
function record(entry: ShellEntry): void {
  const g = globalThis as { __qclodShellLog?: ShellEntry[] }
  ;(g.__qclodShellLog ??= []).push(entry)
}

export function revealPath(abs: string): void {
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
    record({ action: 'reveal', path: abs })
    return
  }
  shell.showItemInFolder(abs)
}

/**
 * The long name Windows will really open. An 8.3 name (`PAYLOA~1.TXT`)
 * shows a different extension than the file has (`.txtzz`), so the type is
 * judged on this, never on what the text said.
 */
function longName(abs: string): string | null {
  try {
    const real = realpathSync.native(abs)
    // Off Windows the same job is done by resolving symlinks: `notes.md` that
    // points at a script is judged as the script.
    if (process.platform !== 'win32') return real.startsWith('/') ? real : null
    return /^[A-Za-z]:\\/.test(real) ? real : null
  } catch {
    return null
  }
}

/**
 * A folder, through explorer.exe rather than ShellExecute.
 *
 * Between the stat and the call the folder can be swapped for a file of the
 * same name, and Explorer hands a file it is given to the file's program. So
 * only a folder whose name, as a file, would be inert or have no program at
 * all (`src`, `notes.md`) is opened; `folder.exe` is only shown.
 */
function openFolder(real: string): 'opened' | 'revealed' {
  if (typeOf(real) !== '' && !isOpenableType(real)) {
    revealPath(real)
    return 'revealed'
  }
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
    record({ action: 'open', path: real })
    return 'opened'
  }
  if (process.platform !== 'win32') {
    // Finder/file manager via the OS; `.app` and other bundle names never get here (typeOf above).
    void shell.openPath(real).then((error) => {
      if (error !== '') shell.showItemInFolder(real)
    })
    return 'opened'
  }
  try {
    const child = spawn('explorer.exe', [`"${real}"`], {
      detached: true,
      windowsVerbatimArguments: true,
      stdio: 'ignore'
    })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    /* Explorer is part of Windows; nothing better to fall back to */
  }
  return 'opened'
}

/**
 * Opens with the default program; a folder opens in Explorer.
 * shell.openPath is never given a name outside the allowlist, whatever the
 * stat said.
 */
export async function openPath(abs: string): Promise<'opened' | 'revealed'> {
  const real = longName(abs)
  if (real === null) {
    revealPath(abs)
    return 'revealed'
  }
  let isDir = false
  try {
    isDir = statSync(real).isDirectory()
  } catch {
    /* gone meanwhile: judged as a file below */
  }
  if (isDir) return openFolder(real)
  if (!isOpenableType(real)) {
    revealPath(real)
    return 'revealed'
  }
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
    record({ action: 'open', path: real })
    return 'opened'
  }
  const error = await shell.openPath(real)
  // No program for this type: Explorer is the next best thing to nothing.
  if (error !== '') {
    shell.showItemInFolder(real)
    return 'revealed'
  }
  return 'opened'
}

const PLACEHOLDER = /\{(path|line|column)\}/g
const HAS_PLACEHOLDER = /\{(path|line|column)\}/
/** One argument as cmd sees it: bare runs and quoted runs glued together. */
const WORD = /(?:[^\s"]+|"[^"]*")+/g
/** cmd still acts on these inside quotes, or they end the user's quote. Parentheses do not. */
const UNSAFE_IN_QUOTES = /[&|<>^%!"]/
const UNSAFE_BARE = /[\s&|<>^()%!"]/

export const EDITOR_CARET =
  'В команде редактора есть ^ вне кавычек — уберите его или возьмите в кавычки.'
export const EDITOR_UNBALANCED = 'В команде редактора непарная кавычка — исправьте её в настройках.'
export const EDITOR_UNSAFE =
  'Этот путь нельзя безопасно подставить в команду редактора: возьмите в кавычки весь аргумент ' +
  'с {path} (например "{path}") или уберите кавычки вокруг него.'

/**
 * The user's editor template with `{path}`, `{line}`, `{column}` filled in.
 * Throws an Error with a message for the user when the result cannot be made
 * safe.
 *
 * Each argument holding a placeholder becomes one argument quoted by
 * `quoteArg`, so `{path}:{line}` stays a single `"C:\a b\x.ts:3"`, and a
 * whole-quoted `"-x {path}"` is re-quoted as a unit. An argument with quotes
 * in the middle (`--file="{path}"`) cannot be re-quoted, so a value goes in
 * as is only when nothing in it means anything to cmd; otherwise nothing runs.
 * Arguments without a placeholder are the user's own and stay as typed.
 */
export function buildEditorCommand(
  template: string,
  target: { path: string; line?: number; column?: number }
): string {
  // cmd reads `^"` as a literal quote, so a caret outside quotes would flip
  // which parts of the line are quoted — and put the path's `&` outside.
  let quoted = false
  for (const ch of template) {
    if (ch === '"') quoted = !quoted
    else if (ch === '^' && !quoted) throw new Error(EDITOR_CARET)
  }
  if (quoted) throw new Error(EDITOR_UNBALANCED)
  const values: Record<string, string> = {
    path: target.path,
    line: String(target.line ?? 1),
    column: String(target.column ?? 1)
  }
  const fill = (text: string, unsafe?: RegExp): string =>
    text.replace(PLACEHOLDER, (_m, key: string) => {
      const value = values[key]!
      if (unsafe && (unsafe.test(value) || value.endsWith('\\'))) throw new Error(EDITOR_UNSAFE)
      return value
    })

  return template.replace(WORD, (word) => {
    if (!HAS_PLACEHOLDER.test(word)) return word
    if (!word.includes('"')) return quoteArg(fill(word))
    if (/^"[^"]*"$/.test(word)) return quoteArg(fill(word.slice(1, -1)))
    // The editor reads `\"` as a literal quote: next to a placeholder it
    // would flip which part of the value is quoted.
    if (word.includes('\\"')) throw new Error(EDITOR_UNSAFE)
    return word
      .split(/("[^"]*")/)
      .map((part) =>
        part.startsWith('"') ? `"${fill(part.slice(1, -1), UNSAFE_IN_QUOTES)}"` : fill(part, UNSAFE_BARE)
      )
      .join('')
  })
}

/**
 * POSIX counterpart of `buildEditorCommand`: the template split into an
 * argument list, no shell involved. Quotes (single or double) group words;
 * `{path}`, `{line}`, `{column}` are filled into each argument as plain text,
 * so nothing in a path can mean anything to anyone. Throws an Error with a
 * message for the user on an unbalanced quote.
 */
export function buildEditorArgv(
  template: string,
  target: { path: string; line?: number; column?: number }
): string[] {
  const values: Record<string, string> = {
    path: target.path,
    line: String(target.line ?? 1),
    column: String(target.column ?? 1)
  }
  const words: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (const ch of template) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur !== '') words.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
    }
  }
  if (quote) throw new Error(EDITOR_UNBALANCED)
  if (has || cur !== '') words.push(cur)
  return words.map((w) => w.replace(PLACEHOLDER, (_m, key: string) => values[key]!))
}

/**
 * The program and arguments to start on macOS/Linux. A program that is an
 * application bundle (`Visual Studio Code.app`) goes through `open -a`; any
 * other is run directly, with the usual tool folders added to PATH, since an
 * app started from Finder does not inherit the shell's PATH (`code` lives in
 * /usr/local/bin or /opt/homebrew/bin).
 */
export function editorSpawnPosix(argv: string[]): { cmd: string; args: string[] } | null {
  const [program, ...rest] = argv
  if (program === undefined || program === '') return null
  if (/\.app\/?$/i.test(program)) return { cmd: 'open', args: ['-a', program, ...rest] }
  return { cmd: program, args: rest }
}

/** cmd.exe's arguments for an editor line — the same as the installer's. */
export const editorShellArgs = cmdShellArgs

/** Starts the editor. Returns null, or a message for the user when the template is unusable. */
export function openInEditor(
  template: string,
  target: { path: string; line?: number; column?: number }
): string | null {
  if (template.trim() === '') return null
  let line = ''
  let posixRun: { cmd: string; args: string[] } | null = null
  try {
    if (process.platform === 'win32') line = buildEditorCommand(template, target)
    else posixRun = editorSpawnPosix(buildEditorArgv(template, target))
  } catch (error) {
    return error instanceof Error ? error.message : EDITOR_UNSAFE
  }
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
    const entry: ShellEntry = { action: 'editor', path: target.path }
    if (target.line !== undefined) entry.line = target.line
    record(entry)
    return null
  }
  if (process.platform !== 'win32') {
    if (posixRun === null) return null
    try {
      const path = [process.env['PATH'], '/opt/homebrew/bin', '/usr/local/bin']
        .filter((p): p is string => !!p)
        .join(':')
      const child = spawn(posixRun.cmd, posixRun.args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PATH: path }
      })
      child.on('error', () => undefined)
      child.unref()
    } catch {
      // A missing editor is the user's setting to fix; the chat carries on.
    }
    return null
  }
  try {
    const child = spawn('cmd.exe', editorShellArgs(line), {
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: 'ignore'
    })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // A missing editor is the user's setting to fix; the chat carries on.
  }
  return null
}
