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
const PASTE_NAME = /^paste-\d+-[0-9a-f]{8}\.(png|jpg|gif|webp)$/i

/** The extensions a pasted image is saved under, and the type each one means. */
export const PASTE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
} as const

export type PasteExt = keyof typeof PASTE_TYPES

/** The type of a saved paste, by its extension. */
export function pasteMediaType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return ext in PASTE_TYPES ? PASTE_TYPES[ext as PasteExt] : 'image/png'
}

/**
 * Writes a pasted image to the app's own scratch folder and returns its path:
 * a copy the user can open from the chat. The extension follows the bytes, so
 * a re-encoded JPEG opens as one.
 */
export function saveImageBuffer(
  userData: string,
  bytes: Buffer,
  ext: PasteExt = 'png'
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
  return pasteRealPath(userData, path) !== null
}

/**
 * The path on disk of one of our own pasted images (see isInsidePasteDir), or
 * null. What is opened is this, never the text the window sent.
 */
export function pasteRealPath(userData: string, path: string): string | null {
  if (!isAbsolute(path) || path.length > 1024) return null
  let real: string
  let dir: string
  try {
    real = realpathSync.native(path)
    dir = realpathSync.native(pasteDir(userData))
    if (!statSync(real).isFile()) return null
  } catch {
    return null
  }
  return dirname(real).toLowerCase() === dir.toLowerCase() && PASTE_NAME.test(basename(real)) ? real : null
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
