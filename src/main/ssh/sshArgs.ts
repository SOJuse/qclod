/**
 * The arguments every ssh Qclod runs starts with (stage 6). The system ssh
 * reads the person's ~/.ssh/config as usual; Qclod adds only what keeps its
 * own promises: nothing local goes to the server (no agent, no forwards), new
 * host keys go to Qclod's own known_hosts (decision 4), and every question ssh
 * asks goes through askpass to the window (task 16).
 */
import { join, posix, win32 } from 'node:path'

export interface SshTarget {
  target: string
  port?: number
  identityFile?: string
}

export interface SshArgsOptions {
  platform: NodeJS.Platform
  userData: string
  uid?: number
  /** Nobody is waiting at the window: give up on a dead host sooner. */
  batch: boolean
  tty?: boolean
}

/** Where ssh writes the host keys Qclod was told to trust. ~/.ssh stays untouched. */
export function knownHostsPath(userData: string): string {
  return join(userData, 'ssh', 'known_hosts')
}

/** The folder of ControlMaster sockets (POSIX only): short, so the socket path stays under 104. */
export function controlDir(uid: number): string {
  return `/tmp/qclod-${uid}`
}

/** ssh's config reader takes `\x` as an escape: Windows paths go with forward slashes. */
function configPath(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.replace(/\\/g, '/') : path
}

export function sshBaseArgs(t: SshTarget, o: SshArgsOptions): string[] {
  const args: string[] = [o.tty ? '-tt' : '-T']
  const opt = (value: string): void => {
    args.push('-o', value)
  }
  opt('ServerAliveInterval=15')
  opt('ServerAliveCountMax=3')
  opt('ForwardAgent=no')
  opt('ClearAllForwardings=yes')
  opt('StrictHostKeyChecking=ask')
  const ours = (o.platform === 'win32' ? win32 : posix).join(o.userData, 'ssh', 'known_hosts')
  opt(`UserKnownHostsFile="${configPath(ours, o.platform)}" ~/.ssh/known_hosts`)
  opt('NumberOfPasswordPrompts=1')
  opt('BatchMode=no')
  if (o.batch) opt('ConnectTimeout=15')
  if (o.platform !== 'win32') {
    const uid = o.uid ?? 0
    opt('ControlMaster=auto')
    opt(`ControlPath=${controlDir(uid)}/cm-%C`)
    opt('ControlPersist=10m')
  }
  if (t.port !== undefined) args.push('-p', String(t.port))
  if (t.identityFile) args.push('-i', configPath(t.identityFile, o.platform))
  args.push(t.target)
  return args
}

/** One word for a POSIX shell: 'a'\''b'. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The remote command as ssh wants it: one string, every part quoted. A
 * leading `~/` stays outside the quotes so the server's shell expands it.
 * The caller puts '--' before it.
 */
export function remoteCommand(argv: string[]): string {
  return argv.map((part) => (part.startsWith('~/') ? `~/${shq(part.slice(2))}` : shq(part))).join(' ')
}
