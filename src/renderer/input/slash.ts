import { EFFORT_LEVELS, type CommandInfo, type ModelOption } from '../../shared/types'
import { filterCommands, isLocalCommand, needsArgument } from '../../shared/commandFilter'
import { EFFORT_LABEL } from '../labels'
import type { InlineMenuItem } from '../components/InlineMenu'

/**
 * Slash commands, typed straight into the input.
 *
 * The owner's complaint about the old palette was blunt: a modal window
 * opened for every command, «зачем он нужен». Now a slash at the start of the
 * line opens a list right above the field, the way `@` opens the file list,
 * and the cursor never leaves the input.
 */

/** Which list the slash menu shows: the commands, or the values for one of them. */
export type SlashStep = { kind: 'commands' } | { kind: 'model' } | { kind: 'effort' }

/**
 * The command being typed, if any: the text starts with `/`, and there is no
 * space or line break before the caret. After a space it is the argument.
 */
export function findSlashQuery(text: string, caret: number): { query: string } | null {
  if (!text.startsWith('/') || caret < 1) return null
  const typed = text.slice(1, caret)
  if (/\s/.test(typed)) return null
  return { query: typed }
}

/** What picking a command does. */
export type SlashOutcome =
  | { kind: 'none' }
  /** Send this text to the session as it is. */
  | { kind: 'send'; text: string }
  /** Put this text in the field and wait — for an argument, or for more typing. */
  | { kind: 'fill'; text: string }
  /** Open the history screen (/resume). */
  | { kind: 'history' }
  /** Show the second list (/model, /effort), with this text in the field. */
  | { kind: 'step'; step: SlashStep; text: string }

/**
 * Enter on a command. Qclod's own commands are decided by name first — the
 * session sends `model` with an argument hint, and it is still ours to answer.
 */
export function acceptCommand(command: CommandInfo): SlashOutcome {
  if (command.unavailableReason) return { kind: 'none' }
  if (isLocalCommand(command.name)) {
    if (command.name === 'resume') return { kind: 'history' }
    const kind = command.name === 'model' ? 'model' : 'effort'
    return { kind: 'step', step: { kind }, text: `/${command.name} ` }
  }
  if (needsArgument(command)) return { kind: 'fill', text: `/${command.name} ` }
  return { kind: 'send', text: `/${command.name}` }
}

/** Tab on a command: write it out, run nothing. */
export function completeCommand(command: CommandInfo): SlashOutcome {
  if (command.unavailableReason) return { kind: 'none' }
  return { kind: 'fill', text: `/${command.name} ` }
}

export function commandItems(
  commands: CommandInfo[],
  query: string,
  recent: string[]
): InlineMenuItem[] {
  return filterCommands(commands, query, recent).map((command) => ({
    id: command.name,
    primary: `/${command.name}`,
    ...(command.argumentHint ? { hint: command.argumentHint } : {}),
    ...(command.description ? { secondary: command.description } : {}),
    ...(command.unavailableReason ? { disabledReason: command.unavailableReason } : {})
  }))
}

function matches(needle: string, ...texts: string[]): boolean {
  const n = needle.trim().toLowerCase()
  return n === '' || texts.some((text) => text.toLowerCase().includes(n))
}

/** The second step of /model: the models this session offers. */
export function modelItems(models: ModelOption[], query: string): InlineMenuItem[] {
  return models
    .filter((model) => matches(query, model.displayName, model.value))
    .map((model) => ({
      id: model.value,
      primary: model.displayName,
      ...(model.description ? { secondary: model.description } : {})
    }))
}

/** The second step of /effort: the levels the chosen model supports. */
export function effortItems(
  models: ModelOption[],
  model: string | null,
  query: string
): InlineMenuItem[] {
  const chosen = models.find((m) => m.value === model)
  const levels = chosen?.supportedEffortLevels ?? EFFORT_LEVELS
  return levels
    .filter((level) => matches(query, level, EFFORT_LABEL[level] ?? ''))
    .map((level) => ({ id: level, primary: EFFORT_LABEL[level] ?? level, hint: level }))
}

/** Sends a slash command to the session, as typed. */
export function sendCommand(tabId: string, text: string): void {
  void window.qclod.send(tabId, { text, attachments: [] })
}

/**
 * Compacts the conversation now. The one path for every place that offers it
 * besides the slash list — the actions menu and the context banner.
 */
export function compactNow(tabId: string): void {
  sendCommand(tabId, '/compact')
}
