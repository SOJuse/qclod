import { mkdirSync, rmSync } from 'node:fs'
import { clip } from '../../shared/format'
import { TEMPLATE_LIMITS, type HarvestOutcome, type HarvestPreview, type PromptTemplate, type TemplateProposal } from '../../shared/types'
import { AgentNotFoundError } from '../agent/resolveExecutable'
import type { TemplateLibrary } from '../store/templatesStore'
import { runOneShot, type QueryLike } from './oneShot'
import { SCAN, scanHumanPrompts, type HarvestItem, type HarvestScan } from './promptScan'

/**
 * «Собрать мои шаблоны»: Qclod reads the person's own messages itself (not
 * Claude), shows exactly what would go, and sends that in one query to their
 * own Claude Code with no tools and no session saved (решение 3). The answer
 * is a JSON array in plain text, read tolerantly (решение 4).
 *
 * The messages live in memory only, for the preview and the one query: they
 * are never written to userData, and never to the log — the log gets a reason
 * at most.
 */
export const HARVEST = { model: 'sonnet', modelLabel: 'Sonnet', timeoutMs: 180_000, maxBudgetUsd: 0.5, maxProposals: 15 } as const

export const HARVEST_SYSTEM_PROMPT =
  'Ты помогаешь человеку собрать личные шаблоны промптов. Ниже — его собственные сообщения агенту Claude Code, каждое в блоке <msg>. ' +
  'Найди просьбы, которые повторяются по смыслу или по форме, и сделай из них не больше 15 шаблонов. ' +
  'Шаблон — готовый текст сообщения на языке оригинала; части, которые каждый раз разные, замени местами вида {{что подставить}}. ' +
  'Не переноси в шаблоны пути, имена, адреса, ключи и другие частные данные — только общую форму просьбы. ' +
  'Ответь только JSON-массивом без пояснений: [{"title": "название до 60 символов", "body": "текст шаблона", "why": "одна фраза: какие сообщения он заменяет"}]. ' +
  'Если повторов нет, ответь [].'

export function buildHarvestPrompt(items: HarvestItem[]): string {
  return items.map((item) => `<msg>\n${item.text.replace(/<\/msg>/g, '<\\/msg>')}\n</msg>`).join('\n')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Two bodies that differ only in case or spacing are one template. */
function sameBody(body: string): string {
  return body.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The proposals in Claude's answer; null — not an array we can read. */
export function parseProposals(text: string, existing: PromptTemplate[]): TemplateProposal[] | null {
  const unfenced = text.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '')
  const start = unfenced.indexOf('[')
  const end = unfenced.lastIndexOf(']')
  if (start === -1 || end < start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const known = new Set(existing.map((t) => sameBody(t.body)))
  const seen = new Set<string>()
  const out: TemplateProposal[] = []
  for (const entry of parsed) {
    if (out.length >= HARVEST.maxProposals) break
    if (!isObject(entry) || typeof entry['title'] !== 'string' || typeof entry['body'] !== 'string') continue
    const body = entry['body'].trim()
    if (body === '' || body.length > TEMPLATE_LIMITS.body) continue
    const key = sameBody(body)
    if (seen.has(key)) continue
    seen.add(key)
    const title = clip(entry['title'].trim(), TEMPLATE_LIMITS.title) || clip(body, 60)
    const why = typeof entry['why'] === 'string' ? entry['why'].trim() : ''
    out.push({ title, body, why, duplicate: known.has(key) })
  }
  return out
}

export interface HarvestDeps {
  /** The owner's Claude Code folder (CLAUDE_CONFIG_DIR or ~/.claude): read only. */
  configDir: string
  query: () => Promise<QueryLike>
  /** The owner's CLI; throws AgentNotFoundError when there is none. */
  executablePath: () => string
  /** `<userData>/tmp/harvest`: an empty folder the query runs in. */
  tmpDir: string
  library: TemplateLibrary
}

export class HarvestService {
  /** The last scan, for «Собрать» to send what the preview showed; memory only. */
  private cache: { excluded: Set<string>; scan: HarvestScan } | null = null
  private running: AbortController | null = null

  constructor(private readonly deps: HarvestDeps) {}

  async preview(excluded: string[]): Promise<HarvestPreview> {
    const scan = await this.scan(excluded, true)
    const chars = scan.items.reduce((n, i) => n + i.text.length, 0)
    return {
      projects: scan.projects,
      items: scan.items.map((i) => ({ projectKey: i.projectKey, text: i.text })),
      prompts: scan.items.length,
      sessions: scan.sessions,
      chars,
      sinceDays: SCAN.sinceDays,
      truncated: scan.truncated,
      model: HARVEST.modelLabel
    }
  }

  /** Sends what the preview showed (or a fresh scan); never texts from the window. */
  async run(excluded: string[]): Promise<HarvestOutcome> {
    if (this.running) return { kind: 'error', reason: 'failed', detail: 'сбор уже идёт' }
    const abort = new AbortController()
    this.running = abort
    try {
      const scan = await this.scan(excluded, false)
      if (abort.signal.aborted) {
        // Cancelled while it read: what it read is forgotten too.
        this.cache = null
        return { kind: 'error', reason: 'cancelled' }
      }
      if (scan.items.length === 0) return { kind: 'empty' }

      let executablePath: string
      try {
        executablePath = this.deps.executablePath()
      } catch (err) {
        if (err instanceof AgentNotFoundError) return { kind: 'error', reason: 'noAgent' }
        throw err
      }
      // An empty folder of our own: the query has no project around it.
      rmSync(this.deps.tmpDir, { recursive: true, force: true })
      mkdirSync(this.deps.tmpDir, { recursive: true })

      const query = await this.deps.query()
      if (abort.signal.aborted) return { kind: 'error', reason: 'cancelled' }
      const answer = await runOneShot(query, {
        systemPrompt: HARVEST_SYSTEM_PROMPT,
        prompt: buildHarvestPrompt(scan.items),
        model: HARVEST.model,
        executablePath,
        cwd: this.deps.tmpDir,
        timeoutMs: HARVEST.timeoutMs,
        maxBudgetUsd: HARVEST.maxBudgetUsd,
        signal: abort.signal
      })
      if (answer.kind === 'error') return answer
      const proposals = parseProposals(answer.text, this.deps.library.list())
      if (proposals === null) return { kind: 'error', reason: 'badAnswer' }
      if (proposals.length === 0) return { kind: 'empty' }
      return { kind: 'ok', proposals, costUsd: answer.costUsd }
    } catch (err) {
      // A reason only: the messages never reach the log.
      const detail = err instanceof Error ? err.message : String(err)
      console.warn('[harvest] сбор не удался:', detail.slice(0, 300))
      return { kind: 'error', reason: 'failed', detail: detail.slice(0, 300) }
    } finally {
      if (this.running === abort) this.running = null
    }
  }

  /** Stops the query and forgets the scan. */
  cancel(): void {
    this.running?.abort()
    this.cache = null
  }

  /** For tests: whether a scan is held in memory. */
  hasCachedScan(): boolean {
    return this.cache !== null
  }

  /**
   * The cached scan when it covers this choice — the projects left out now
   * include every one left out then, so filtering is enough — else a new one.
   */
  private async scan(excluded: string[], fresh: boolean): Promise<HarvestScan> {
    const now = new Set(excluded)
    const cached = this.cache
    if (!fresh && cached && [...cached.excluded].every((key) => now.has(key))) {
      return {
        ...cached.scan,
        projects: cached.scan.projects.filter((p) => !now.has(p.key)),
        items: cached.scan.items.filter((i) => !now.has(i.projectKey))
      }
    }
    const scan = await scanHumanPrompts(this.deps.configDir, { excluded })
    this.cache = { excluded: now, scan }
    return scan
  }
}
