import type { CommandInfo } from './types'

/**
 * Commands Qclod answers itself instead of forwarding.
 *
 * `/resume` in the terminal opens an interactive picker that does not exist in
 * a headless session — forwarding it would do nothing at all. Qclod has the
 * same thing as a screen, so the command opens that.
 */
export const LOCAL_COMMANDS: Record<string, string> = {
  resume: 'Открыть прошлый разговор',
  model: 'Выбрать модель',
  effort: 'Выбрать усилие',
  'remote-control': 'Включить или выключить Remote Control для этой вкладки'
}

/**
 * A command that needs an argument cannot simply be sent: «/model» on its own
 * does nothing useful. Either Qclod answers it itself (above), or the command
 * is put into the input for the user to finish.
 */
export function needsArgument(command: CommandInfo): boolean {
  return command.argumentHint.trim() !== '' && !isLocalCommand(command.name)
}

export function isLocalCommand(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(LOCAL_COMMANDS, name)
}

/** Qclod's own wording for the commands it answers itself; the rest pass through. */
export function markUnavailable(commands: CommandInfo[]): CommandInfo[] {
  return commands.map((command) => {
    const local = LOCAL_COMMANDS[command.name]
    return local ? { ...command, description: local } : command
  })
}

/**
 * Greys out /remote-control with the reason Remote Control cannot be switched
 * on right now; `null` leaves the list as it is.
 */
export function markRemote(commands: CommandInfo[], blockedText: string | null): CommandInfo[] {
  if (blockedText === null) return commands
  return commands.map((command) =>
    command.name === 'remote-control' ? { ...command, unavailableReason: blockedText } : command
  )
}

/**
 * The list the slash menu offers: what the session sent, plus the commands
 * Qclod answers itself when the session did not send them — /model must work
 * before the session has said a word.
 */
export function withLocalCommands(commands: CommandInfo[]): CommandInfo[] {
  const present = new Set(commands.map((command) => command.name))
  const missing = Object.entries(LOCAL_COMMANDS)
    .filter(([name]) => !present.has(name))
    .map(([name, description]) => ({
      name,
      description,
      argumentHint: '',
      ...(name === 'remote-control' ? { aliases: ['rc'] } : {})
    }))
  return markUnavailable([...commands, ...missing])
}

/** Subsequence match: `cmp` finds `compact`. Returns null when it does not fit. */
export function score(text: string, needle: string): number | null {
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
 * The slash menu's list.
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
