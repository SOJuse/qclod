/**
 * «src/a.ts:3» and «src/a.ts:3:7» → { path: 'src/a.ts', line: 3 }. The colon of
 * a drive («C:\x\a.ts») is not a line; no line, or line 0, or a tail that is not
 * a number leaves the text as it is.
 */
export function splitPathLine(text: string): { path: string; line?: number } {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(text)
  if (!m) return { path: text }
  const line = Number(m[2])
  if (!Number.isSafeInteger(line) || line < 1) return { path: text }
  return { path: m[1] ?? text, line }
}
