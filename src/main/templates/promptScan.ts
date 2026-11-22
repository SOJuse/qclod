import type { HarvestProject } from '../../shared/types'
import { listSessionFiles, readTranscriptTexts } from '../history/transcriptText'

/**
 * What «Собрать мои шаблоны» reads: the person's own messages of the last 90
 * days, newest first, within a budget (решение 3). Nothing of it is written
 * anywhere — not to userData, not to the log.
 */
export const SCAN = { sinceDays: 90, maxPrompts: 400, maxChars: 60_000, perPromptMax: 2_000, minChars: 12 } as const

const DAY_MS = 24 * 60 * 60 * 1000

export interface HarvestItem {
  projectKey: string
  text: string
  at: number
}

export interface HarvestScan {
  projects: HarvestProject[]
  items: HarvestItem[]
  sessions: number
  truncated: boolean
}

/** Two prompts that differ only in case or spacing are one. */
function sameKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export async function scanHumanPrompts(
  configDir: string,
  opts: { now?: number; excluded?: string[] } = {}
): Promise<HarvestScan> {
  const now = opts.now ?? Date.now()
  const excluded = new Set(opts.excluded ?? [])
  const since = now - SCAN.sinceDays * DAY_MS
  const files = (await listSessionFiles(configDir)).filter((f) => f.mtimeMs >= since && !excluded.has(f.projectKey))

  const seen = new Set<string>()
  const items: HarvestItem[] = []
  const projects = new Map<string, HarvestProject>()
  let chars = 0
  let sessions = 0
  let truncated = false

  for (const file of files) {
    if (truncated) break
    const texts: { text: string; at: number }[] = []
    let cwd: string | null = null
    try {
      for await (const t of readTranscriptTexts(file.path, (m) => (cwd = m.cwd))) {
        if (t.human) texts.push({ text: t.text, at: t.at })
      }
    } catch {
      // A file that went away or cannot be read: the rest still count.
      continue
    }

    // The file's newest first, so a repeated prompt keeps its latest time.
    let taken = 0
    for (const { text: full, at } of texts.reverse()) {
      if (full.length < SCAN.minChars) continue
      const text = full.slice(0, SCAN.perPromptMax)
      const key = sameKey(text)
      if (seen.has(key)) continue
      if (items.length >= SCAN.maxPrompts || chars + text.length > SCAN.maxChars) {
        truncated = true
        break
      }
      seen.add(key)
      items.push({ projectKey: file.projectKey, text, at: at || file.mtimeMs })
      chars += text.length
      taken++
      const project = projects.get(file.projectKey) ?? {
        key: file.projectKey,
        label: cwd ?? file.projectKey,
        sessions: 0,
        prompts: 0,
        chars: 0
      }
      if (taken === 1) project.sessions++
      project.prompts++
      project.chars += text.length
      projects.set(file.projectKey, project)
    }
    if (taken > 0) sessions++
  }

  return { projects: [...projects.values()], items, sessions, truncated }
}
