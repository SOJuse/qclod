import type { UserInput } from '../../shared/types'

/** `@путь` with quotes when it contains spaces — the convention probe 1 confirmed. */
export function mention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

/**
 * The text that actually goes to the agent: what the user typed, plus an
 * `@`-mention per attached file.
 *
 * There is exactly one of these, on purpose. When the session composed one
 * string and the driver composed another, the CLI echoed back the driver's
 * version, the session did not recognise it as the echo of what it had already
 * shown, and every message with an attachment appeared twice — the second time
 * with the raw `@"C:\Мои проекты\файл 1.ts"` the user never typed.
 */
export function composeText(input: UserInput): string {
  const files = input.attachments.filter((a) => a.kind === 'file')
  return [input.text, ...files.map((f) => (f.kind === 'file' ? mention(f.path) : ''))]
    .filter((part) => part.trim() !== '')
    .join('\n')
}
