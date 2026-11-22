import { execFile } from 'node:child_process'
import { lstat, mkdir, open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { buildFileIndex } from '../core/fileIndex'
import type { FsEntry } from '../shared/relayProtocol'
import { RelayError, badRequest } from './errors'
import { SESSION_ID } from './stateStore'

export const LIST_MAX = 2000
export const STAT_MAX = 200
export const READ_MAX = 256 * 1024
export const UPLOAD_MAX = 100 * 1024 * 1024
export const UPLOAD_NAME_MAX = 120

/** `~` and `~/…` are the home folder; anything else is taken as it is. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

function absolute(path: string, home: string, base = home): string {
  const expanded = expandHome(path, home)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

function fsError(error: unknown, what: string): RelayError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return new RelayError('not_found', `${what}: нет такого`)
  if (code === 'ENOTDIR') return badRequest(`${what}: не папка`)
  if (code === 'EACCES' || code === 'EPERM') return badRequest(`${what}: нет доступа`)
  if (code === 'EISDIR') return badRequest(`${what}: это папка`)
  return new RelayError('internal', `${what}: ${code ?? 'ошибка'}`)
}

/** A folder's entries: at most 2000, folders first, by name; hidden ones at the end. */
export async function listDir(path: string, home: string): Promise<{ path: string; entries: FsEntry[]; truncated: boolean }> {
  const dir = absolute(path, home)
  let names
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    throw fsError(error, 'папка')
  }
  const rank = (name: string, isDir: boolean): number => (name.startsWith('.') ? 2 : 0) + (isDir ? 0 : 1)
  const sorted = names
    .map((d) => ({ d, dir: d.isDirectory() }))
    .sort((a, b) => rank(a.d.name, a.dir) - rank(b.d.name, b.dir) || (a.d.name < b.d.name ? -1 : a.d.name > b.d.name ? 1 : 0))
  const kept = sorted.slice(0, LIST_MAX)
  const entries = await Promise.all(
    kept.map(async ({ d, dir: isDir }): Promise<FsEntry> => {
      let size = 0
      let mtime = 0
      try {
        const s = await lstat(join(dir, d.name))
        size = s.size
        mtime = s.mtimeMs
      } catch {
        // Gone meanwhile: listed with nothing known.
      }
      return { name: d.name, kind: d.isSymbolicLink() ? 'link' : isDir ? 'dir' : 'file', size, mtime }
    })
  )
  return { path: dir, entries, truncated: sorted.length > LIST_MAX }
}

/** Which of the paths exist, relative to `cwd` or absolute; null where not (≤ 200). */
export async function statMany(
  cwd: string,
  paths: string[],
  home: string
): Promise<Array<{ abs: string; kind: 'file' | 'dir' } | null>> {
  if (!Array.isArray(paths) || paths.length > STAT_MAX) throw badRequest(`не больше ${STAT_MAX} путей`)
  const base = absolute(cwd, home)
  return Promise.all(
    paths.map(async (p) => {
      if (typeof p !== 'string' || p === '') return null
      const abs = absolute(p, home, base)
      try {
        const s = await stat(abs)
        return s.isDirectory() ? { abs, kind: 'dir' as const } : s.isFile() ? { abs, kind: 'file' as const } : null
      } catch {
        return null
      }
    })
  )
}

/** A piece of a file, at most 256 KiB, as base64. */
export async function readChunk(
  path: string,
  offset: number,
  length: number,
  home = ''
): Promise<{ dataBase64: string; size: number; eof: boolean }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest('offset')
  if (!Number.isSafeInteger(length) || length < 0 || length > READ_MAX) throw badRequest(`length не больше ${READ_MAX}`)
  const file = home ? absolute(path, home) : resolve(path)
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    throw fsError(error, 'файл')
  }
  try {
    const { size } = await handle.stat()
    const want = Math.max(0, Math.min(length, size - offset))
    const buffer = Buffer.alloc(want)
    const { bytesRead } = want > 0 ? await handle.read(buffer, 0, want, offset) : { bytesRead: 0 }
    return {
      dataBase64: buffer.subarray(0, bytesRead).toString('base64'),
      size,
      eof: offset + bytesRead >= size
    }
  } catch (error) {
    throw fsError(error, 'файл')
  } finally {
    await handle.close()
  }
}

/**
 * What every git call of the relay carries: the folder is anybody's, and its
 * .git/config may name a fsmonitor, a pager, an external diff or a credential
 * helper — listing its files must run none of them (as GIT_BASE_ARGS of stage 7).
 */
export const GIT_SAFE_ARGS = [
  '--no-pager',
  '--literal-pathspecs',
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.pager=cat',
  '-c',
  'diff.external=',
  '-c',
  'credential.helper='
]

function git(root: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    execFile(
      'git',
      [...GIT_SAFE_ARGS, '-C', root, ...args],
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LANGUAGE: 'C' }
      },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        done({ code, stdout: String(stdout ?? '') })
      }
    )
  })
}

/** The folder's files for @-mentions: git's own list in a repository, else core/fileIndex. */
export async function indexFiles(root: string, limit: number): Promise<{ files: string[]; truncated: boolean }> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw badRequest('limit')
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code === 0 && inside.stdout.trim() === 'true') {
    const listed = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    if (listed.code === 0) {
      const files = [...new Set(listed.stdout.split('\0').filter((f) => f !== ''))]
      return { files: files.slice(0, limit), truncated: files.length > limit }
    }
  }
  const files = await buildFileIndex(root, { limit: limit + 1 })
  return { files: files.slice(0, limit), truncated: files.length > limit }
}

/** Letters and digits of any script, `_`, `.`, `-` and the space; at most 120 characters. */
function cleanName(name: string): string {
  const clean = [...name.normalize('NFC').replace(/[^\p{L}\p{N}_.\- ]/gu, '_')].slice(0, UPLOAD_NAME_MAX).join('')
  return clean.replace(/^\.+/, (dots) => '_'.repeat(dots.length)) || 'file'
}

function within(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !isAbsolute(rel)
}

/** A new numbered file in `dir`: created exclusively, so two uploads of one name never share it. */
async function createNumbered(dir: string, clean: string): Promise<{ path: string; handle: FileHandle }> {
  const numbers = (await readdir(dir)).map((entry) => /^(\d+)-/.exec(entry)?.[1]).filter((n) => n !== undefined)
  let next = numbers.reduce((max, n) => Math.max(max, Number(n)), 0) + 1
  for (let tries = 0; tries < 1000; tries++, next++) {
    const path = join(dir, `${next}-${clean}`)
    try {
      return { path, handle: await open(path, 'wx', 0o600) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw fsError(error, 'файл загрузки')
    }
  }
  throw new RelayError('internal', 'нет свободного номера загрузки')
}

/** The file a later chunk names: in uploads/<s>/ itself, a plain file, as long as the offset. */
async function continued(realDir: string, path: string, offset: number): Promise<string> {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) throw badRequest('нет начала этого файла')
  const target = resolve(path)
  let realParent: string
  try {
    realParent = await realpath(dirname(target))
  } catch {
    throw badRequest('нет начала этого файла')
  }
  if (realParent !== realDir || !/^\d+-/.test(basename(target))) throw badRequest('кусок не из этой загрузки')
  let info
  try {
    info = await lstat(target)
  } catch {
    throw badRequest('нет начала этого файла')
  }
  if (!info.isFile() || info.size !== offset) throw badRequest('кусок не продолжает файл')
  return target
}

/**
 * One chunk of a file sent from Qclod, into uploads/<s>/<n>-<name>. A first
 * chunk (offset 0) starts a new numbered file and answers its path; every later
 * chunk names that path, and goes on only if it is a file of uploads/<s>/ as
 * long as the chunk's offset. Two files of one name uploaded side by side thus
 * never land in one. Nothing is written outside uploads/<s>/ — a name with a
 * path in it, a path elsewhere, or a link that leads out, is refused.
 */
export async function writeUpload(
  uploadsDir: string,
  s: string,
  name: string,
  offset: number,
  data: Buffer,
  _final: boolean,
  path?: string
): Promise<{ path: string }> {
  if (!SESSION_ID.test(s)) throw badRequest('id сессии')
  if (typeof name !== 'string' || name === '' || /[\\/]/.test(name) || name.includes('..')) throw badRequest('имя файла')
  if (!Number.isSafeInteger(offset) || offset < 0) throw badRequest('offset')
  if (offset + data.length > UPLOAD_MAX) throw new RelayError('too_large', 'Файл больше 100 МБ')

  await mkdir(uploadsDir, { recursive: true, mode: 0o700 })
  const dir = join(uploadsDir, s)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const [realRoot, realDir] = await Promise.all([realpath(uploadsDir), realpath(dir)])
  if (!within(realDir, realRoot)) throw badRequest('папка загрузок ведёт наружу')

  let target: string
  let handle: FileHandle
  if (offset === 0) {
    ;({ path: target, handle } = await createNumbered(dir, cleanName(name)))
  } else {
    target = await continued(realDir, path ?? '', offset)
    handle = await open(target, 'r+')
  }
  try {
    await handle.write(data, 0, data.length, offset)
  } finally {
    await handle.close()
  }
  return { path: target }
}
