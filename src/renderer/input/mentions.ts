export interface MentionQuery {
  /** Index of the "@" in the text. */
  start: number
  query: string
}

/**
 * Finds the `@`-mention the caret is currently inside, if any. An "@" that
 * follows a word character is part of an email address, not a mention.
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      const before = i > 0 ? text[i - 1] : ' '
      if (!/\s/.test(before)) return null
      return { start: i, query: text.slice(i + 1, caret) }
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/** Wraps a path in quotes when it contains spaces, so the CLI sees one token. */
export function quotePath(path: string): string {
  if (!/\s/.test(path)) return path
  return `"${path.replace(/"/g, '\\"')}"`
}

export interface MentionResult {
  text: string
  caret: number
}

export function applyMention(
  text: string,
  start: number,
  caret: number,
  path: string
): MentionResult {
  const inserted = `@${quotePath(path)} `
  const next = text.slice(0, start) + inserted + text.slice(caret)
  return { text: next, caret: start + inserted.length }
}
