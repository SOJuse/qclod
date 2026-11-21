import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { privateMode } from './journal'
import { BINARY_NAME, type RelayPaths } from './paths'

export type Supervisor = 'systemd' | 'tmux' | 'plain'

export const UNIT_NAME = 'qclod-relay'

/**
 * ~/.config/systemd/user/qclod-relay.service — the one file Qclod writes outside ~/.qclod.
 *
 * Restart=on-failure with 75 forced: a crash (SIGKILL, OOM) and a restart asked
 * for (exit 75) bring the daemon back; exit 0 — another daemon already serves —
 * does not, so the unit never loops on a busy lock. KillMode=mixed: a stop
 * signals the daemon alone, which suspends its agents itself and marks the
 * working ones for «продолжай» before they go.
 */
export const UNIT_TEXT = [
  '[Unit]',
  'Description=Qclod relay',
  '',
  '[Service]',
  `ExecStart=%h/.qclod/bin/${BINARY_NAME} daemon`,
  'Restart=on-failure',
  'RestartForceExitStatus=75',
  'RestartSec=2',
  'KillMode=mixed',
  'TimeoutStopSec=20',
  '',
  '[Install]',
  'WantedBy=default.target',
  ''
].join('\n')

export interface SetupResult {
  supervisor: Supervisor
  linger: 'yes' | 'no' | 'unknown'
  lingerTried: boolean
}

export type Run = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>

/** Where setup's answer is kept, for host.info. */
export const SETUP_FILE = 'setup.json'

function binaryPath(paths: RelayPaths): string {
  return posix.join(paths.bin, BINARY_NAME)
}

/** How to start the daemon under each supervisor. */
export function startCommand(s: Supervisor, bin = posix.join(homedir(), '.qclod', 'bin', BINARY_NAME)): { cmd: string; args: string[] } {
  switch (s) {
    case 'systemd':
      return { cmd: 'systemctl', args: ['--user', 'start', UNIT_NAME] }
    case 'tmux':
      return { cmd: 'tmux', args: ['new-session', '-d', '-s', UNIT_NAME, `'${bin.replace(/'/g, `'\\''`)}' daemon`] }
    case 'plain':
      return { cmd: 'setsid', args: ['-f', bin, 'daemon'] }
  }
}

async function lingerOf(run: Run, user: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const { code, stdout } = await run('loginctl', ['show-user', user, '--property=Linger'])
    if (code !== 0) return 'unknown'
    const match = /^Linger=(yes|no)\s*$/m.exec(stdout)
    return match ? (match[1] as 'yes' | 'no') : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function succeeds(run: Run, cmd: string, args: string[]): Promise<boolean> {
  try {
    return (await run(cmd, args)).code === 0
  } catch {
    return false
  }
}

/**
 * Makes the daemon outlive the ssh session that installed it. Linger (user
 * services running with nobody logged in) is read first and, if off, asked for
 * once without sudo. A systemd user unit only with Linger on — without it the
 * user's manager, and the agents with it, stop when the last ssh session ends
 * (the Mac closed) — and only if `enable --now` really took. Else a tmux
 * session, else a plain detached process; a unit of an earlier setup is then
 * taken away, so attach does not start the daemon under it. setup run again
 * once Linger is on moves the daemon to systemd.
 */
export async function setup(run: Run, paths: RelayPaths, user: string): Promise<SetupResult> {
  const bin = binaryPath(paths)
  let linger = await lingerOf(run, user)
  let lingerTried = false
  if (linger === 'no') {
    lingerTried = true
    await succeeds(run, 'loginctl', ['enable-linger', user])
    linger = await lingerOf(run, user)
  }

  const unitDir = join(dirname(paths.root), '.config', 'systemd', 'user')
  const unitFile = join(unitDir, `${UNIT_NAME}.service`)
  const systemd = await succeeds(run, 'systemctl', ['--user', 'show-environment'])
  let supervisor: Supervisor | null = null
  if (systemd && linger === 'yes') {
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(unitFile, UNIT_TEXT, { mode: 0o644 })
    await run('systemctl', ['--user', 'daemon-reload'])
    if (await succeeds(run, 'systemctl', ['--user', 'enable', '--now', UNIT_NAME])) supervisor = 'systemd'
  }
  if (supervisor === null && systemd && existsSync(unitFile)) {
    await succeeds(run, 'systemctl', ['--user', 'disable', UNIT_NAME])
    rmSync(unitFile, { force: true })
    await succeeds(run, 'systemctl', ['--user', 'daemon-reload'])
  }
  if (supervisor === null && (await succeeds(run, 'tmux', ['-V']))) {
    supervisor = 'tmux'
    // A tmux session of that name already there is a daemon already running.
    if (!(await succeeds(run, 'tmux', ['has-session', '-t', UNIT_NAME]))) {
      const { cmd, args } = startCommand('tmux', bin)
      await run(cmd, args)
    }
  }
  if (supervisor === null) {
    supervisor = 'plain'
    const { cmd, args } = startCommand('plain', bin)
    await run(cmd, args)
  }

  const result: SetupResult = { supervisor, linger, lingerTried }
  try {
    mkdirSync(paths.root, { recursive: true, mode: 0o700 })
    writeFileSync(join(paths.root, SETUP_FILE), JSON.stringify(result), { mode: 0o600 })
    privateMode(join(paths.root, SETUP_FILE), 0o600)
  } catch {
    // host.info then says «unknown».
  }
  return result
}
