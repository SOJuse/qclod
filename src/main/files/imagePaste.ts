import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const PASTE_DIR_NAME = 'pastes'

export interface CleanupLimits {
  maxAgeDays: number
  maxBytes: number
}

export const DEFAULT_LIMITS: CleanupLimits = { maxAgeDays: 7, maxBytes: 256 * 1024 * 1024 }

function pasteDir(userData: string): string {
  return join(userData, PASTE_DIR_NAME)
}

/**
 * Writes a pasted image to the app's own scratch folder and returns its path.
 * The path, not the bytes, is what reaches the agent (spec 6.6).
 */
export function saveImageBuffer(userData: string, png: Buffer): string | null {
  if (png.length === 0) return null
  const dir = pasteDir(userData)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `paste-${Date.now()}-${randomUUID().slice(0, 8)}.png`)
  writeFileSync(path, png)
  return path
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
