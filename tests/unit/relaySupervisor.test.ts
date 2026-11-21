import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { relayPaths } from '../../src/relay/paths'
import { SETUP_FILE, UNIT_TEXT, setup, startCommand, type Run } from '../../src/relay/supervisor'
import { cleanTemps, tempDir } from './relayHarness'

afterEach(cleanTemps)

/** A stand-in for the shell: answers by the command line, records every call. */
function stub(answers: Record<string, { code: number | null; stdout?: string } | Array<{ code: number | null; stdout?: string }>>) {
  const calls: string[] = []
  const seen = new Map<string, number>()
  const run: Run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    const answer = answers[line]
    if (!answer) return { code: 1, stdout: '' }
    if (Array.isArray(answer)) {
      const i = seen.get(line) ?? 0
      seen.set(line, i + 1)
      const a = answer[Math.min(i, answer.length - 1)]!
      return { code: a.code, stdout: a.stdout ?? '' }
    }
    return { code: answer.code, stdout: answer.stdout ?? '' }
  }
  return { run, calls }
}

function paths() {
  const home = tempDir('qclod-setup-')
  return { home, paths: relayPaths(home, 'linux', join(home, '.qclod')) }
}

describe('установка службы посредника', () => {
  test('unit: Restart=always, ExecStart из ~/.qclod/bin', () => {
    expect(UNIT_TEXT).toContain('Description=Qclod relay')
    expect(UNIT_TEXT).toContain('ExecStart=%h/.qclod/bin/qclod-relay daemon')
    expect(UNIT_TEXT).toContain('Restart=always')
    expect(UNIT_TEXT).toContain('RestartSec=2')
    expect(UNIT_TEXT).toContain('WantedBy=default.target')
  })

  test('есть systemd — enable --now и unit с Restart=always', async () => {
    const { home, paths: p } = paths()
    const { run, calls } = stub({
      'systemctl --user show-environment': { code: 0, stdout: 'HOME=/home/u' },
      'systemctl --user daemon-reload': { code: 0 },
      'systemctl --user enable --now qclod-relay': { code: 0 },
      'loginctl show-user u --property=Linger': { code: 0, stdout: 'Linger=yes\n' }
    })
    const result = await setup(run, p, 'u')
    expect(result).toEqual({ supervisor: 'systemd', linger: 'yes', lingerTried: false })
    expect(calls).toContain('systemctl --user daemon-reload')
    expect(calls).toContain('systemctl --user enable --now qclod-relay')
    expect(calls.some((c) => c.startsWith('tmux'))).toBe(false)
    const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'qclod-relay.service'), 'utf8')
    expect(unit).toBe(UNIT_TEXT)
    expect(JSON.parse(readFileSync(join(p.root, SETUP_FILE), 'utf8'))).toEqual(result)
  })

  test('нет systemd, есть tmux — tmux', async () => {
    const { paths: p } = paths()
    const { run, calls } = stub({
      'tmux -V': { code: 0, stdout: 'tmux 3.4' },
      'loginctl show-user u --property=Linger': { code: 0, stdout: 'Linger=yes' }
    })
    const result = await setup(run, p, 'u')
    expect(result.supervisor).toBe('tmux')
    const started = calls.find((c) => c.startsWith('tmux new-session'))
    expect(started).toBe(`tmux new-session -d -s qclod-relay '${p.bin}/qclod-relay' daemon`)
  })

  test('tmux-сессия уже есть — второй демон не запускается', async () => {
    const { paths: p } = paths()
    const { run, calls } = stub({ 'tmux -V': { code: 0 }, 'tmux has-session -t qclod-relay': { code: 0 } })
    await setup(run, p, 'u')
    expect(calls.some((c) => c.startsWith('tmux new-session'))).toBe(false)
  })

  test('ни systemd, ни tmux — plain через setsid', async () => {
    const { paths: p } = paths()
    const { run, calls } = stub({})
    const result = await setup(run, p, 'u')
    expect(result).toEqual({ supervisor: 'plain', linger: 'unknown', lingerTried: false })
    expect(calls).toContain(`setsid -f ${p.bin}/qclod-relay daemon`)
  })

  test('Linger=no, enable-linger не удался — {linger:no, lingerTried:true}', async () => {
    const { paths: p } = paths()
    const { run, calls } = stub({
      'systemctl --user show-environment': { code: 0 },
      'systemctl --user daemon-reload': { code: 0 },
      'systemctl --user enable --now qclod-relay': { code: 0 },
      'loginctl show-user u --property=Linger': { code: 0, stdout: 'Linger=no' },
      'loginctl enable-linger u': { code: 1 }
    })
    expect(await setup(run, p, 'u')).toEqual({ supervisor: 'systemd', linger: 'no', lingerTried: true })
    expect(calls).toContain('loginctl enable-linger u')
    expect(calls.filter((c) => c.startsWith('loginctl show-user'))).toHaveLength(2)
  })

  test('Linger=no, enable-linger удался — yes', async () => {
    const { paths: p } = paths()
    const { run } = stub({
      'tmux -V': { code: 0 },
      'loginctl show-user u --property=Linger': [{ code: 0, stdout: 'Linger=no' }, { code: 0, stdout: 'Linger=yes' }],
      'loginctl enable-linger u': { code: 0 }
    })
    expect(await setup(run, p, 'u')).toEqual({ supervisor: 'tmux', linger: 'yes', lingerTried: true })
  })

  test('startCommand по супервизору', () => {
    expect(startCommand('systemd')).toEqual({ cmd: 'systemctl', args: ['--user', 'start', 'qclod-relay'] })
    expect(startCommand('tmux', "/home/o'k/.qclod/bin/qclod-relay")).toEqual({
      cmd: 'tmux',
      args: ['new-session', '-d', '-s', 'qclod-relay', `'/home/o'\\''k/.qclod/bin/qclod-relay' daemon`]
    })
    expect(startCommand('plain', '/home/u/.qclod/bin/qclod-relay')).toEqual({
      cmd: 'setsid',
      args: ['-f', '/home/u/.qclod/bin/qclod-relay', 'daemon']
    })
  })
})
