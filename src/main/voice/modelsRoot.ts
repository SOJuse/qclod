import { spawnSync } from 'node:child_process'
import { posix, win32 } from 'node:path'

export interface ModelsRootDeps {
  platform: string
  shortPath(p: string): string | null
  env: NodeJS.ProcessEnv
}

/** Every character is plain ASCII: sherpa gets paths as `char*`, read in the ANSI code page. */
export function isAsciiPath(p: string): boolean {
  return /^[\x20-\x7e]*$/.test(p)
}

/**
 * The 8.3 short form of an existing path, or null. Asked from cmd.exe
 * (`%~sI`); with 8.3 names off on the volume it answers the long path, which
 * the caller rejects for not being ASCII.
 */
export function windowsShortPath(p: string): string | null {
  const comspec = win32.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const r = spawnSync(comspec, ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: true,
    timeout: 5000
  })
  if (r.error !== undefined || r.status !== 0 || typeof r.stdout !== 'string') return null
  const line = r.stdout.trim()
  return line.length > 0 ? line : null
}

/** Где лежат модели: userData/models, если sherpa читает такой путь; иначе короткий путь 8.3; иначе %ProgramData%\Qclod\models. */
export function modelsRoot(
  userData: string,
  deps: ModelsRootDeps = { platform: process.platform, shortPath: windowsShortPath, env: process.env }
): string {
  if (deps.platform !== 'win32') return posix.join(userData, 'models')
  const plain = win32.join(userData, 'models')
  if (isAsciiPath(plain)) return plain
  const short = deps.shortPath(userData)
  if (short !== null && isAsciiPath(short)) return win32.join(short, 'models')
  return win32.join(deps.env['ProgramData'] ?? 'C:\\ProgramData', 'Qclod', 'models')
}
