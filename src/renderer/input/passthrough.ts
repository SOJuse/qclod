/**
 * Slash commands belong to the CLI: it draws the command menu as you type, and
 * it knows about the user's own and plugin commands. So the moment the line
 * starts with "/", the composer stops buffering and forwards keystrokes live
 * (spec 6.4).
 */
export function shouldEnterPassthrough(text: string): boolean {
  return text.startsWith('/')
}

export function shouldExitPassthrough(text: string): boolean {
  return !text.startsWith('/')
}

/** The whole state machine: passthrough is on exactly while the line starts with "/". */
export function nextPassthrough(current: boolean, text: string): boolean {
  return current ? !shouldExitPassthrough(text) : shouldEnterPassthrough(text)
}
