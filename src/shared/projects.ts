/** `C:\…` or `C:/…`, and a bare `C:`. */
const DRIVE_PATH = /^[a-zA-Z]:([\\/]|$)/
/** `\\host\…` or `//host/…`. */
const UNC_PATH = /^[\\/]{2}[^\\/]/

function folderKey(cwd: string): string {
  if (DRIVE_PATH.test(cwd)) {
    const key = cwd.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
    // Down to the drive itself: its root is `c:\`, never a bare `c:`.
    return key.length === 2 ? `${key}\\` : key
  }
  if (UNC_PATH.test(cwd)) {
    return cwd.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
  }
  const key = cwd.replace(/\/+$/, '')
  return key === '' && cwd !== '' ? '/' : key
}

/**
 * The key a folder is known by, so that one folder is one project however
 * its path was written: `/` becomes `\` and case is dropped for Windows paths
 * (`C:\…`, `\\host\…`), and a trailing separator goes, except at a root.
 * Any other path keeps its case: on such a file system it matters.
 *
 * A folder on another machine (этап 6) is prefixed with that machine's id,
 * `srv1:/home/u/p`: the same path there is another project. Without a
 * `hostId` the folder is local and the key is the path alone.
 */
export function projectKey(cwd: string, hostId?: string): string {
  const key = folderKey(cwd)
  return hostId ? `${hostId}:${key}` : key
}

/** What the sidebar calls a folder: the last part of its path; a drive's root is «C:». */
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, '')
  if (trimmed === '') return cwd
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? trimmed
}
