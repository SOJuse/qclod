import type { AppSettings, LaunchOverrides } from '../../shared/types'

/**
 * Splits a free-form extra-flags string the way a shell would, so a path with
 * spaces stays one argument instead of falling apart.
 */
export function splitFlags(input: string | undefined): string[] {
  if (!input) return []
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started || current.length > 0) out.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
  }
  if (started || current.length > 0) out.push(current)
  return out
}

function pick(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/**
 * Builds the agent's argv. Tab overrides win over the global defaults key by
 * key, so a tab that only pins a model still inherits everything else.
 */
export function buildLaunchArgs(
  settings: AppSettings,
  overrides: LaunchOverrides,
  settingsJson: string
): string[] {
  const defaults = settings.defaults ?? {}
  const args: string[] = ['--settings', settingsJson]

  const model = pick(overrides.model, defaults.model)
  if (model) args.push('--model', model)

  const permissionMode = pick(overrides.permissionMode, defaults.permissionMode)
  if (permissionMode) args.push('--permission-mode', permissionMode)

  const mcpConfig = pick(overrides.mcpConfig, defaults.mcpConfig)
  if (mcpConfig) args.push('--mcp-config', mcpConfig)

  args.push(...splitFlags(defaults.extraFlags), ...splitFlags(overrides.extraFlags))
  return args
}
