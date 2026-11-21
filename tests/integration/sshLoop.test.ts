/**
 * The ssh loop (stage 6): a real sshd on the CI runner (ubuntu-latest), the
 * relay's test binary installed over ssh the way Qclod installs it, and the
 * protocol spoken through `qclod-relay attach` over a real ssh channel.
 *
 * Runs only with QCLOD_SSH_LOOP_HOST (CI: localhost, key in ~/.ssh) and
 * QCLOD_RELAY_BINARY_DIR (dist-relay-e2e). Steps 1–3 are here; task 18
 * replaces the plain ssh calls with Qclod's own modules (probe, install,
 * RelayClient) and adds step 4: a session on the fake SDK, a cut connection
 * and a catch-up with `after` — nothing lost, nothing twice.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LineDecoder, RELAY_PROTO, encodeFrame, type RelayFrame } from '../../src/shared/relayProtocol'

const HOST = process.env['QCLOD_SSH_LOOP_HOST']
const BINARY_DIR = process.env['QCLOD_RELAY_BINARY_DIR'] ?? 'dist-relay-e2e'

/** The options Qclod's own ssh calls carry: nothing of this machine goes to the server. */
const SSH_OPTS = [
  '-T',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ForwardAgent=no',
  '-o', 'ClearAllForwardings=yes'
]

function ssh(command: string, input?: Buffer | string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...SSH_OPTS, HOST!, '--', command])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}

/** What Qclod's probe asks (task 15 replaces it with probeScript): arch and libc. */
const PROBE = [
  'echo "arch=$(uname -m)"',
  'if ldd --version 2>&1 | grep -qi musl; then echo libc=musl; else echo libc=glibc; fi',
  'command -v tmux >/dev/null && echo tmux=yes || echo tmux=no'
].join('\n')

let attach: ChildProcessWithoutNullStreams | null = null

afterAll(async () => {
  attach?.kill()
  if (!HOST) return
  // The loop leaves nothing running behind it.
  await ssh('tmux kill-session -t qclod-relay 2>/dev/null; systemctl --user stop qclod-relay 2>/dev/null; true')
})

describe.skipIf(!HOST)('ssh-петля: посредник на настоящем sshd', () => {
  test('1. проба через ssh … sh -s: arch x64, libc glibc', async () => {
    const { code, stdout, stderr } = await ssh('sh -s', PROBE)
    expect(code, stderr).toBe(0)
    const fields = Object.fromEntries(stdout.trim().split('\n').map((l) => l.split('=') as [string, string]))
    const arch = fields['arch'] === 'x86_64' ? 'x64' : fields['arch'] === 'aarch64' ? 'arm64' : fields['arch']
    expect({ arch, libc: fields['libc'] }).toEqual({ arch: 'x64', libc: 'glibc' })
  })

  test('2. установка бинарника и setup: supervisor tmux или systemd', async () => {
    const binary = readFileSync(join(BINARY_DIR, 'qclod-relay-linux-x64'))
    const install = await ssh(
      'mkdir -p ~/.qclod/bin && chmod 700 ~/.qclod && cat > ~/.qclod/bin/qclod-relay.part && ' +
        'chmod 700 ~/.qclod/bin/qclod-relay.part && mv ~/.qclod/bin/qclod-relay.part ~/.qclod/bin/qclod-relay',
      binary
    )
    expect(install.code, install.stderr).toBe(0)
    const version = await ssh('~/.qclod/bin/qclod-relay version')
    expect(JSON.parse(version.stdout)).toMatchObject({ proto: RELAY_PROTO })
    const setup = await ssh('~/.qclod/bin/qclod-relay setup')
    expect(setup.code, setup.stderr).toBe(0)
    const result = JSON.parse(setup.stdout) as { supervisor: string; linger: string }
    expect(['tmux', 'systemd']).toContain(result.supervisor)
  })

  test('3. attach: welcome.proto === 1', async () => {
    attach = spawn('ssh', [...SSH_OPTS, HOST!, '--', '~/.qclod/bin/qclod-relay attach'])
    const decoder = new LineDecoder()
    const frames: RelayFrame[] = []
    attach.stdout.on('data', (chunk: Buffer) => frames.push(...decoder.push(chunk)))
    attach.stdin.write(encodeFrame({ t: 'hello', proto: RELAY_PROTO, app: 'sshLoop', client: 'ci' }))
    const started = Date.now()
    while (!frames.some((f) => f.t === 'welcome')) {
      if (Date.now() - started > 20_000) throw new Error('нет welcome за 20 с')
      await new Promise((r) => setTimeout(r, 50))
    }
    const welcome = frames.find((f) => f.t === 'welcome') as Extract<RelayFrame, { t: 'welcome' }>
    expect(welcome.proto).toBe(1)
    attach.stdin.write(encodeFrame({ t: 'ping' }))
    while (!frames.some((f) => f.t === 'pong')) {
      if (Date.now() - started > 25_000) throw new Error('нет pong')
      await new Promise((r) => setTimeout(r, 50))
    }
  })
})
