import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { privateMode } from './journal'
import { BINARY_NAME, type RelayPaths } from './paths'

export type Supervisor = 'systemd' | 'tmux' | 'plain'

export const UNIT_NAME = 'qclod-relay'

/** ~/.config/systemd/user/qclod-relay.service — the one file Qclod writes outside ~/.qclod. */
export const UNIT_TEXT = [
  '[Unit]',
  'Description=Qclod relay',
  '',
  '[Service]',
  `ExecStart=%h/.qclod/bin/${BINARY_NAME} daemon`,
  'Restart=always',
  'RestartSec=2',
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
 * Makes the daemon outlive the ssh session that installed it: a systemd user
 * unit where `systemctl --user` works, else a tmux session, else a plain
 * detached process. Linger (user services running with nobody logged in) is
 * read and, if off, asked for once without sudo.
 */
export async function setup(run: Run, paths: RelayPaths, user: string): Promise<SetupResult> {
  const bin = binaryPath(paths)
  let supervisor: Supervisor
  if (await succeeds(run, 'systemctl', ['--user', 'show-environment'])) {
    supervisor = 'systemd'
    const unitDir = join(dirname(paths.root), '.config', 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(join(unitDir, `${UNIT_NAME}.service`), UNIT_TEXT, { mode: 0o644 })
    await run('systemctl', ['--user', 'daemon-reload'])
    await run('systemctl', ['--user', 'enable', '--now', UNIT_NAME])
  } else if (await succeeds(run, 'tmux', ['-V'])) {
    supervisor = 'tmux'
    // A tmux session of that name already there is a daemon already running.
    if (!(await succeeds(run, 'tmux', ['has-session', '-t', UNIT_NAME]))) {
      const { cmd, args } = startCommand('tmux', bin)
      await run(cmd, args)
    }
  } else {
    supervisor = 'plain'
    const { cmd, args } = startCommand('plain', bin)
    await run(cmd, args)
  }

  let linger = await lingerOf(run, user)
  let lingerTried = false
  if (linger === 'no') {
    lingerTried = true
    await succeeds(run, 'loginctl', ['enable-linger', user])
    linger = await lingerOf(run, user)
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
