/**
 * Flags a tab's launch options may not carry.
 *
 * The «дополнительные флаги» box exists so someone can pass `--verbose` or a
 * model alias without waiting for Qclod to grow a setting for it. It is not a
 * way around the permission system: every flag here either turns the gate off,
 * redirects it somewhere Qclod cannot see, or widens what the agent may touch
 * beyond the folder the tab is for.
 *
 * Matching is on the flag name only, so `--permission-mode=plan` and
 * `--permission-mode plan` are both caught.
 */
const FORBIDDEN = [
  'dangerously-skip-permissions',
  'allow-dangerously-skip-permissions',
  'permission-mode',
  'permission-prompt-tool',
  'allowedtools',
  'allowed-tools',
  'disallowedtools',
  'disallowed-tools',
  'settings',
  'mcp-config',
  'add-dir',
  'strict-mcp-config'
]

export interface ParsedFlags {
  /** Ready for the SDK: names without `--`, `null` for a bare flag. */
  args: Record<string, string | null>
  /** Flags that were refused, as the user typed them. */
  rejected: string[]
}

function splitTokens(text: string): string[] {
  return text.match(/"[^"]*"|\S+/g)?.map((token) => token.replace(/^"|"$/g, '')) ?? []
}

/**
 * Turns the text of the setting into arguments the SDK accepts, dropping
 * anything that would touch permissions.
 *
 * A rejected flag is reported rather than silently removed: a setting that
 * quietly does nothing is worse than one that says no.
 */
export function parseExtraFlags(text: string | undefined): ParsedFlags {
  const args: Record<string, string | null> = {}
  const rejected: string[] = []
  if (!text) return { args, rejected }

  const tokens = splitTokens(text)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token.startsWith('--')) continue

    const equals = token.indexOf('=')
    const name = (equals === -1 ? token.slice(2) : token.slice(2, equals)).trim()
    if (name === '') continue

    if (FORBIDDEN.includes(name.toLowerCase())) {
      rejected.push(token)
      // Skip its value too, so a refused flag cannot leave an orphan behind.
      if (equals === -1 && tokens[i + 1] !== undefined && !tokens[i + 1]!.startsWith('--')) i++
      continue
    }

    if (equals !== -1) {
      args[name] = token.slice(equals + 1)
      continue
    }

    const next = tokens[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[name] = next
      i++
    } else {
      args[name] = null
    }
  }

  return { args, rejected }
}
