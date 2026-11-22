import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESTART_EXIT_CODE } from '../../src/relay/daemon'
import { cachedBinaryVersion, successorEnv } from '../../src/relay/env'
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
  test('unit: Restart=on-failure и 75, KillMode=mixed, ExecStart из ~/.qclod/bin', () => {
    expect(UNIT_TEXT).toContain('Description=Qclod relay')
    expect(UNIT_TEXT).toContain('ExecStart=%h/.qclod/bin/qclod-relay daemon')
    // exit 0 (another daemon serves) is no reason to come back: no loop every 2 s on a busy lock
    expect(UNIT_TEXT).not.toContain('Restart=always')
    expect(UNIT_TEXT).toContain('Restart=on-failure')
    expect(UNIT_TEXT).toContain(`RestartForceExitStatus=${RESTART_EXIT_CODE}`)
    expect(UNIT_TEXT).toContain('RestartSec=2')
    // a stop signals the daemon alone; it suspends the agents and marks the working ones itself
    expect(UNIT_TEXT).toContain('KillMode=mixed')
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

  test('Linger=no, enable-linger не удался — не systemd, а tmux; unit не включается', async () => {
    const { home, paths: p } = paths()
    const { run, calls } = stub({
      'systemctl --user show-environment': { code: 0 },
      'systemctl --user daemon-reload': { code: 0 },
      'systemctl --user enable --now qclod-relay': { code: 0 },
      'tmux -V': { code: 0 },
      'loginctl show-user u --property=Linger': { code: 0, stdout: 'Linger=no' },
      'loginctl enable-linger u': { code: 1 }
    })
    expect(await setup(run, p, 'u')).toEqual({ supervisor: 'tmux', linger: 'no', lingerTried: true })
    expect(calls).toContain('loginctl enable-linger u')
    expect(calls.filter((c) => c.startsWith('loginctl show-user'))).toHaveLength(2)
    expect(calls).not.toContain('systemctl --user enable --now qclod-relay')
    expect(existsSync(join(home, '.config', 'systemd', 'user', 'qclod-relay.service'))).toBe(false)
    expect(calls.some((c) => c.startsWith('tmux new-session'))).toBe(true)
  })

  test('Linger не узнать, tmux нет — plain', async () => {
    const { paths: p } = paths()
    const { run, calls } = stub({ 'systemctl --user show-environment': { code: 0 } })
    expect(await setup(run, p, 'u')).toEqual({ supervisor: 'plain', linger: 'unknown', lingerTried: false })
    expect(calls).not.toContain('systemctl --user enable --now qclod-relay')
  })

  test('unit прошлой установки при Linger=no — выключен и убран', async () => {
    const { home, paths: p } = paths()
    const unit = join(home, '.config', 'systemd', 'user', 'qclod-relay.service')
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true })
    writeFileSync(unit, UNIT_TEXT)
    const { run, calls } = stub({
      'systemctl --user show-environment': { code: 0 },
      'tmux -V': { code: 0 },
      'loginctl show-user u --property=Linger': { code: 0, stdout: 'Linger=no' }
    })
    expect((await setup(run, p, 'u')).supervisor).toBe('tmux')
    expect(calls).toContain('systemctl --user disable qclod-relay')
    expect(existsSync(unit)).toBe(false)
  })

  test('enable --now не удался — setup не говорит systemd', async () => {
    const { paths: p } = paths()
    const { run } = stub({
      'systemctl --user show-environment': { code: 0 },
      'systemctl --user daemon-reload': { code: 0 },
      'systemctl --user enable --now qclod-relay': { code: 1 },
      'tmux -V': { code: 0 },
      'loginctl show-user u --property=Linger': { code: 0, stdout: 'Linger=yes' }
    })
    expect((await setup(run, p, 'u')).supervisor).toBe('tmux')
  })

  test('повторный setup, когда Linger появился, переводит на systemd', async () => {
    const { home, paths: p } = paths()
    const answers = {
      'systemctl --user show-environment': { code: 0 },
      'systemctl --user daemon-reload': { code: 0 },
      'systemctl --user enable --now qclod-relay': { code: 0 },
      'tmux -V': { code: 0 },
      'tmux has-session -t qclod-relay': { code: 0 },
      'loginctl show-user u --property=Linger': { code: 0, stdout: 'Linger=no' }
    }
    expect((await setup(stub(answers).run, p, 'u')).supervisor).toBe('tmux')
    const again = stub({ ...answers, 'loginctl show-user u --property=Linger': { code: 0, stdout: 'Linger=yes' } })
    expect(await setup(again.run, p, 'u')).toEqual({ supervisor: 'systemd', linger: 'yes', lingerTried: false })
    expect(again.calls).toContain('systemctl --user enable --now qclod-relay')
    expect(readFileSync(join(home, '.config', 'systemd', 'user', 'qclod-relay.service'), 'utf8')).toBe(UNIT_TEXT)
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

  test('преемник демона под tmux не наследует TMUX и метки systemd', () => {
    expect(
      successorEnv({ PATH: '/usr/bin', HOME: '/home/u', TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%0', INVOCATION_ID: 'x' })
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/u' })
  })

  test('версия файла посредника спрашивается заново, только когда файл сменился', async () => {
    const { home } = paths()
    const binary = join(home, 'qclod-relay')
    let asked = 0
    const versionOf = cachedBinaryVersion(binary, '1.0.0', async () => {
      asked++
      return asked === 1 ? '1.0.0' : '1.0.1'
    })
    // no file yet: the running daemon's
    expect(await versionOf()).toBe('1.0.0')
    expect(asked).toBe(0)
    writeFileSync(binary, 'old')
    expect(await versionOf()).toBe('1.0.0')
    expect(await versionOf()).toBe('1.0.0')
    expect(asked).toBe(1)
    writeFileSync(binary, 'newer')
    const later = new Date(Date.now() + 5000)
    utimesSync(binary, later, later)
    expect(await versionOf()).toBe('1.0.1')
    expect(asked).toBe(2)
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
