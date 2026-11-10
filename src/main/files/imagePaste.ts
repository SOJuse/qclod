import { mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join } from 'node:path'

export const PASTE_DIR_NAME = 'pastes'

export interface CleanupLimits {
  maxAgeDays: number
  maxBytes: number
}

export const DEFAULT_LIMITS: CleanupLimits = { maxAgeDays: 7, maxBytes: 256 * 1024 * 1024 }

function pasteDir(userData: string): string {
  return join(userData, PASTE_DIR_NAME)
}

/** Every name saveImageBuffer gives, and nothing else. */
const PASTE_NAME = /^paste-\d+-[0-9a-f]{8}\.(png|jpg)$/i

/**
 * Writes a pasted image to the app's own scratch folder and returns its path:
 * a copy the user can open from the chat. The extension follows the bytes, so
 * a re-encoded JPEG opens as one.
 */
export function saveImageBuffer(
  userData: string,
  bytes: Buffer,
  ext: 'png' | 'jpg' = 'png'
): string | null {
  if (bytes.length === 0) return null
  const dir = pasteDir(userData)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `paste-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`)
  writeFileSync(path, bytes)
  return path
}

/**
 * Whether a path is one of our own pasted images: an existing file directly in
 * userData/pastes, under a name saveImageBuffer gives. Judged on the real
 * paths on disk, so `..`, a look-alike folder (`pastes-x`), a junction or
 * an 8.3 name cannot pass for it.
 */
export function isInsidePasteDir(userData: string, path: string): boolean {
  if (!isAbsolute(path) || path.length > 1024) return false
  let real: string
  let dir: string
  try {
    real = realpathSync.native(path)
    dir = realpathSync.native(pasteDir(userData))
    if (!statSync(real).isFile()) return false
  } catch {
    return false
  }
  return dirname(real).toLowerCase() === dir.toLowerCase() && PASTE_NAME.test(basename(real))
}

/**
 * Keeps the scratch folder from growing without bound: screenshot-heavy use
 * would otherwise quietly fill the disk. Oldest first, by age then by size.
 */
export function cleanupPasteDir(userData: string, limits: CleanupLimits = DEFAULT_LIMITS): void {
  const dir = pasteDir(userData)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  const cutoff = Date.now() - limits.maxAgeDays * 24 * 60 * 60 * 1000
  const files: Array<{ path: string; mtime: number; size: number }> = []

  for (const name of entries) {
    const path = join(dir, name)
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    if (!stats.isFile()) continue

    if (stats.mtimeMs < cutoff) {
      try {
        rmSync(path, { force: true })
      } catch {
        /* someone else has it open; try again next start */
      }
      continue
    }
    files.push({ path, mtime: stats.mtimeMs, size: stats.size })
  }

  let total = files.reduce((sum, file) => sum + file.size, 0)
  if (total <= limits.maxBytes) return

  files.sort((a, b) => a.mtime - b.mtime)
  for (const file of files) {
    if (total <= limits.maxBytes) break
    try {
      rmSync(file.path, { force: true })
      total -= file.size
    } catch {
      /* skip */
    }
  }
}
