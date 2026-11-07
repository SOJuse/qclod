import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RULES_FILE = 'permission-rules.json'

export interface PermissionRule {
  id: string
  toolName: string
  /** The exact target the rule is about — a file path, a command. Absent means any. */
  target?: string
  behavior: 'allow' | 'deny'
}

/**
 * «Разрешить всё такое» is kept here, in Qclod's own storage.
 *
 * The SDK's own «don't ask again» writes into `.claude/settings.local.json`
 * inside the user's repository. That would break constraint 5 — the user's
 * settings files are never modified — and litter someone else's repo for our
 * convenience (spec 6.4).
 */
export function loadRules(dir: string): PermissionRule[] {
  let raw: string
  try {
    raw = readFileSync(join(dir, RULES_FILE), 'utf8')
  } catch {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const rules: PermissionRule[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const rule = entry as Record<string, unknown>
    if (typeof rule['toolName'] !== 'string' || rule['toolName'] === '') continue
    if (rule['behavior'] !== 'allow' && rule['behavior'] !== 'deny') continue
    rules.push({
      id: typeof rule['id'] === 'string' ? rule['id'] : `${Date.now()}-${rules.length}`,
      toolName: rule['toolName'],
      ...(typeof rule['target'] === 'string' ? { target: rule['target'] } : {}),
      behavior: rule['behavior']
    })
  }
  return rules
}

export function saveRules(dir: string, rules: PermissionRule[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, RULES_FILE), JSON.stringify(rules, null, 2), 'utf8')
}

/**
 * What the tool is acting on, as a rule records it: the whole path or the whole
 * command, never a prefix. A rule remembered for one file must not quietly
 * cover its neighbours.
 */
export function ruleTarget(input: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'notebook_path', 'command', 'url']) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * Looks for a decision the user has already made. `null` means nobody has, and
 * the person gets asked. A deny always wins over an allow: the narrower, more
 * cautious answer is the safe one when both match.
 */
export function matchRule(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>
): 'allow' | 'deny' | null {
  const target = ruleTarget(input)
  const matching = rules.filter(
    (rule) =>
      rule.toolName === toolName && (rule.target === undefined || rule.target === target)
  )
  if (matching.length === 0) return null
  return matching.some((rule) => rule.behavior === 'deny') ? 'deny' : 'allow'
}
