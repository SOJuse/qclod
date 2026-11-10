/**
 * A terminal's control sequences, removed: colours and cursor moves (CSI),
 * titles and links (OSC), and the two-character escapes. get_task_output
 * hands back what the command printed, escape sequences included (sdk.d.ts),
 * and as plain text they are noise like «[32m».
 */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/**
 * What a failed IPC call says, without Electron's wrapper
 * «Error invoking remote method 'x': Error: …».
 */
export function remoteErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}
