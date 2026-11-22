/**
 * What a server has before Qclod puts anything there (stage 6): one POSIX sh
 * script through `ssh … sh -s`, printing key=value lines between two marks —
 * a login shell's motd and banners around them are noise.
 */
import type { ConnectStep } from '../../shared/types'

export const MIN_SERVER_CLI = '2.1.296'

const BEGIN = '__QCLOD_PROBE_BEGIN__'
const END = '__QCLOD_PROBE_END__'

export const PROBE_SCRIPT = `
echo ${BEGIN}
echo "os=$(uname -s 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
l=$(ldd --version 2>&1 </dev/null)
case "$l" in
  *musl*) echo libc=musl ;;
  *GLIBC*|*glibc*|*"GNU libc"*|*"GNU C Library"*) echo libc=glibc ;;
  *) echo libc=unknown ;;
esac
echo "home=$HOME"
echo "user=$(id -un 2>/dev/null || echo "$USER")"
echo "shell=$SHELL"
cand=$("\${SHELL:-/bin/sh}" -lc 'command -v claude' 2>/dev/null </dev/null | tail -n 1)
cl=
for f in "$cand" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /usr/local/bin/claude; do
  if [ -n "$f" ] && [ -x "$f" ]; then cl=$f; break; fi
done
echo "claudePath=$cl"
if [ -n "$cl" ]; then echo "claudeVersion=$("$cl" --version 2>/dev/null </dev/null | head -n 1)"; fi
r="$HOME/.qclod/bin/qclod-relay"
if [ -x "$r" ]; then echo "relayVersion=$("$r" version 2>/dev/null </dev/null | head -n 1)"; fi
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then echo systemdUser=1; else echo systemdUser=0; fi
echo "linger=$(loginctl show-user "$(id -un 2>/dev/null)" --property=Linger --value 2>/dev/null </dev/null)"
if command -v tmux >/dev/null 2>&1; then echo tmux=1; else echo tmux=0; fi
if command -v gzip >/dev/null 2>&1; then echo gzip=1; else echo gzip=0; fi
echo ${END}
`

export interface ProbeResult {
  os: string
  arch: 'x64' | 'arm64' | 'other'
  /** `uname -m` as the server said it, for the text when arch is 'other'. */
  machine?: string
  libc: 'glibc' | 'musl' | 'unknown'
  home: string
  user: string
  shell: string
  claudePath: string | null
  claudeVersion: string | null
  relayVersion: string | null
  systemdUser: boolean
  linger: 'yes' | 'no' | 'unknown'
  tmux: boolean
  gzip: boolean
}

function firstVersion(text: string | undefined): string | null {
  return text ? (/\d+\.\d+\.\d+/.exec(text)?.[0] ?? null) : null
}

export function parseProbe(stdout: string): ProbeResult | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.replace(/\r$/, ''))
  const begin = lines.indexOf(BEGIN)
  const end = lines.indexOf(END, begin + 1)
  if (begin < 0 || end < 0) return null
  const kv = new Map<string, string>()
  for (const line of lines.slice(begin + 1, end)) {
    const eq = line.indexOf('=')
    if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1).trim())
  }
  const machine = kv.get('arch') ?? ''
  const arch = machine === 'x86_64' || machine === 'amd64' ? 'x64' : machine === 'aarch64' || machine === 'arm64' ? 'arm64' : 'other'
  const libc = kv.get('libc')
  const linger = kv.get('linger')
  const claudePath = kv.get('claudePath') || null
  return {
    os: kv.get('os') ?? '',
    arch,
    machine,
    libc: libc === 'glibc' || libc === 'musl' ? libc : 'unknown',
    home: kv.get('home') ?? '',
    user: kv.get('user') ?? '',
    shell: kv.get('shell') ?? '',
    claudePath,
    claudeVersion: claudePath ? firstVersion(kv.get('claudeVersion')) : null,
    relayVersion: firstVersion(kv.get('relayVersion')),
    systemdUser: kv.get('systemdUser') === '1',
    linger: linger === 'yes' || linger === 'no' ? linger : 'unknown',
    tmux: kv.get('tmux') === '1',
    gzip: kv.get('gzip') === '1'
  }
}

/** -1, 0, 1 for x.y.z; anything unreadable counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** The checklist's «Claude Code на сервере». Qclod never installs it (I14). */
export function claudeStep(p: ProbeResult): ConnectStep {
  const fail = (text: string): ConnectStep => ({ id: 'claude', state: 'fail', text })
  if (p.os !== 'Linux' || p.arch === 'other') {
    const arch = p.arch === 'other' ? p.machine || 'other' : p.arch
    return fail(`Нужен Linux x64 или arm64, а у сервера ${p.os || '?'}/${arch}.`)
  }
  if (p.libc === 'musl') return fail('Сервер на musl (например, Alpine) пока не поддерживается.')
  if (!p.claudePath || !p.claudeVersion) {
    return fail(
      'Claude Code на сервере не найден. Qclod сам его не устанавливает. Установите его на сервере: ' +
        'curl -fsSL https://claude.ai/install.sh | bash — и нажмите «Проверить снова».'
    )
  }
  if (compareVersions(p.claudeVersion, MIN_SERVER_CLI) < 0) {
    return fail(
      `Claude Code на сервере устарел (${p.claudeVersion}), нужен ${MIN_SERVER_CLI} или новее. ` +
        'Выполните на сервере: claude update'
    )
  }
  return { id: 'claude', state: 'ok', text: `Claude Code ${p.claudeVersion}` }
}
