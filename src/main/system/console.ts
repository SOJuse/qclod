import { spawn } from 'node:child_process'
import { quoteArg } from '../setup/install'

/** The environment variable that carries the agent's command line to the inner cmd. */
const AGENT_LINE_VAR = 'QCLOD_AGENT_LINE'

export type ConsoleSpawn = (
  file: string,
  args: string[],
  opts: {
    cwd?: string
    detached: boolean
    windowsHide: boolean
    windowsVerbatimArguments?: boolean
    env?: NodeJS.ProcessEnv
    stdio?: 'ignore'
  }
) => { on(event: 'error', fn: (e: Error) => void): unknown; unref(): void }

/** The line typed into the terminal: the agent itself, interactive. */
export function agentCommandLine(agent: string): string {
  return /\.js$/i.test(agent) ? `node ${quoteArg(agent)}` : quoteArg(agent)
}

/**
 * Opens Claude Code in a console window of its own, in the tab's folder — for
 * the commands that exist only in the terminal (/chrome, /config, /login…).
 * The line travels the same way as the login window's (auth.ts): through an
 * environment variable, so only the inner cmd ever parses the path.
 */
export function openAgentTerminal(agent: string, cwd: string, spawnFn: ConsoleSpawn = spawn): void {
  const child = spawnFn(
    'cmd.exe',
    ['/d', '/v:off', '/c', 'start', '""', 'cmd.exe', '/d', '/v:off', '/s', '/k', `^"%${AGENT_LINE_VAR}^%^"`],
    {
      cwd,
      detached: true,
      windowsHide: false,
      windowsVerbatimArguments: true,
      env: { ...process.env, [AGENT_LINE_VAR]: agentCommandLine(agent) }
    }
  )
  child.on('error', (e) => console.warn('[terminal]', e.message))
  child.unref()
}

/**
 * Presses Win+H: Windows' own voice typing, which writes into whatever field
 * has the focus — the input line, which the window focused just before.
 * Chromium's speech API needs a Google key Electron does not ship, and the
 * Windows panel already knows Russian, punctuation and the user's microphone.
 */
const VOICE_SCRIPT = `
Add-Type -Namespace Qclod -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
[Qclod.Keys]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
[Qclod.Keys]::keybd_event(0x48, 0, 0, [UIntPtr]::Zero)
[Qclod.Keys]::keybd_event(0x48, 0, 2, [UIntPtr]::Zero)
[Qclod.Keys]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
`

/** PowerShell's -EncodedCommand: UTF-16LE in base64, so nothing in it is ever quoted. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export function startVoiceTyping(spawnFn: ConsoleSpawn = spawn): void {
  const child = spawnFn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(VOICE_SCRIPT)],
    { detached: false, windowsHide: true, stdio: 'ignore' }
  )
  child.on('error', (e) => console.warn('[voice]', e.message))
  child.unref()
}
