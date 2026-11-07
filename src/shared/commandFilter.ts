import type { CommandInfo } from './types'

/**
 * Commands that cannot work here, with the reason the user will read.
 *
 * Remote Control drives the terminal UI Qclod no longer runs — the trade the
 * user accepted knowingly when choosing the SDK rewrite (spec 6.7). It is
 * shown greyed with its reason rather than hidden: a command that vanishes
 * without explanation reads as a bug.
 */
const UNAVAILABLE: Record<string, string> = {
  'remote-control': 'Remote Control работает только в терминале, не в Qclod',
  rc: 'Remote Control работает только в терминале, не в Qclod'
}

export function markUnavailable(commands: CommandInfo[]): CommandInfo[] {
  return commands.map((command) => {
    const reason = UNAVAILABLE[command.name]
    return reason ? { ...command, unavailableReason: reason } : command
  })
}

/** Subsequence match: `cmp` finds `compact`. Returns null when it does not fit. */
function score(text: string, needle: string): number | null {
  if (needle === '') return 0
  if (text === needle) return 1000
  if (text.startsWith(needle)) return 500 - text.length

  let at = -1
  let points = 0
  let previous = -2
  for (const char of needle) {
    at = text.indexOf(char, at + 1)
    if (at === -1) return null
    // Letters that sit together read as a better match than ones scattered.
    points += at === previous + 1 ? 6 : 2
    previous = at
  }
  return points - text.length / 10
}

/**
 * The palette's list.
 *
 * With no query the recent commands come first — five or six names do most of
 * the work and should not need typing. With a query everything is searched by
 * name and description together, so a command can be found by what it does as
 * well as by what it is called.
 */
export function filterCommands(
  all: CommandInfo[],
  query: string,
  recent: string[]
): CommandInfo[] {
  const needle = query.trim().toLowerCase().replace(/^\//, '')

  if (needle === '') {
    const byName = new Map(all.map((command) => [command.name, command]))
    const top: CommandInfo[] = []
    for (const name of recent) {
      const command = byName.get(name)
      // A command that is no longer offered must not linger as a ghost.
      if (!command) continue
      byName.delete(name)
      top.push(command)
    }
    return [...top, ...byName.values()]
  }

  const scored: Array<{ command: CommandInfo; points: number }> = []
  for (const command of all) {
    const byName = score(command.name.toLowerCase(), needle)
    const byDescription = score(command.description.toLowerCase(), needle)
    const best =
      byName !== null && byDescription !== null
        ? Math.max(byName, byDescription / 2)
        : byName !== null
          ? byName
          : byDescription !== null
            ? byDescription / 2
            : null
    if (best !== null) scored.push({ command, points: best })
  }

  scored.sort((a, b) => b.points - a.points || a.command.name.localeCompare(b.command.name))
  return scored.map((entry) => entry.command)
}
