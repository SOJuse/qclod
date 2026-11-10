import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import { quoteArg } from '../setup/install'

/**
 * What a click on a path in the chat may do. A path comes from the agent's
 * text, so nothing here ever starts a program: an executable, a script or a
 * shortcut is shown in Explorer instead, where the user decides.
 *
 * The plan's list, plus the other types Windows runs or hands to an
 * interpreter on a double click (.url, .scf, .msc, .chm, .application, …).
 */
const RUNNABLE = new Set([
  '.exe', '.bat', '.cmd', '.com', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.msi', '.msp', '.scr', '.hta', '.lnk', '.jar', '.reg', '.cpl',
  '.pif', '.appref-ms',
  '.url', '.scf', '.msc', '.chm', '.application', '.gadget', '.settingcontent-ms',
  '.ws', '.wsc', '.ps1xml', '.psc1', '.diagcab', '.xll'
])

export function isRunnable(path: string): boolean {
  // Windows drops trailing dots and spaces, so `setup.exe.` runs setup.exe.
  return RUNNABLE.has(extname(path.replace(/[. ]+$/, '')).toLowerCase())
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

/** Opens with the default program; a folder opens in Explorer. */
export async function openPath(abs: string): Promise<'opened' | 'revealed'> {
  if (isRunnable(abs)) {
    revealPath(abs)
    return 'revealed'
  }
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
    record({ action: 'open', path: abs })
    return 'opened'
  }
  const error = await shell.openPath(abs)
  // No program for this type: Explorer is the next best thing to nothing.
  if (error !== '') {
    shell.showItemInFolder(abs)
    return 'revealed'
  }
  return 'opened'
}

const PLACEHOLDER = /\{(path|line|column)\}/g

/**
 * The user's editor template with `{path}`, `{line}`, `{column}` filled in.
 *
 * Each whitespace-separated word holding a placeholder becomes one quoted
 * argument, so `{path}:{line}` stays a single `"C:\a b\x.ts:3"`. Words
 * without one are the user's own and stay as typed.
 */
export function buildEditorCommand(
  template: string,
  target: { path: string; line?: number; column?: number }
): string {
  const values: Record<string, string> = {
    path: target.path,
    line: String(target.line ?? 1),
    column: String(target.column ?? 1)
  }
  return template.replace(/\S+/g, (word) => {
    if (!/\{(path|line|column)\}/.test(word)) return word
    // A user who quoted the placeholder already means the same argument.
    const bare = word.length > 1 && word.startsWith('"') && word.endsWith('"') ? word.slice(1, -1) : word
    return quoteArg(bare.replace(PLACEHOLDER, (_m, key: string) => values[key]!))
  })
}

export function openInEditor(
  template: string,
  target: { path: string; line?: number; column?: number }
): void {
  if (template.trim() === '') return
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SHELL']) {
    const entry: ShellEntry = { action: 'editor', path: target.path }
    if (target.line !== undefined) entry.line = target.line
    record(entry)
    return
  }
  const line = buildEditorCommand(template, target)
  try {
    // Quoted whole, as Node does for `shell: true`: with /s cmd strips exactly
    // that outer pair and runs the line as written.
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
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
}
