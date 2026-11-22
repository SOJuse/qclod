import { describe, expect, test } from 'vitest'
import { MIN_SERVER_CLI, PROBE_SCRIPT, claudeStep, parseProbe, type ProbeResult } from '@main/ssh/probe'
import { classifySshFailure } from '@main/ssh/sshRun'

const SAMPLE = [
  'Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-49-generic x86_64)',
  ' * Documentation:  https://help.ubuntu.com',
  'os=Linux (не метка: до начала)',
  '__QCLOD_PROBE_BEGIN__',
  'os=Linux',
  'arch=aarch64',
  'libc=glibc',
  'home=/home/me',
  'user=me',
  'shell=/bin/bash',
  'claudePath=/home/me/.local/bin/claude',
  'claudeVersion=2.1.317 (Claude Code)',
  'relayVersion=qclod-relay 1.0.0 proto 1',
  'systemdUser=1',
  'linger=no',
  'tmux=1',
  'gzip=1',
  '__QCLOD_PROBE_END__',
  'logout'
].join('\n')

function probe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    os: 'Linux',
    arch: 'x64',
    libc: 'glibc',
    home: '/home/me',
    user: 'me',
    shell: '/bin/bash',
    claudePath: '/home/me/.local/bin/claude',
    claudeVersion: '2.1.317',
    relayVersion: null,
    systemdUser: true,
    linger: 'yes',
    tmux: true,
    gzip: true,
    ...over
  }
}

describe('parseProbe', () => {
  test('образец с шумом motd до меток', () => {
    expect(parseProbe(SAMPLE)).toEqual({
      os: 'Linux',
      arch: 'arm64',
      machine: 'aarch64',
      libc: 'glibc',
      home: '/home/me',
      user: 'me',
      shell: '/bin/bash',
      claudePath: '/home/me/.local/bin/claude',
      claudeVersion: '2.1.317',
      relayVersion: '1.0.0',
      systemdUser: true,
      linger: 'no',
      tmux: true,
      gzip: true
    })
  })

  test('без меток — null', () => {
    expect(parseProbe('os=Linux\narch=x86_64\n')).toBeNull()
    expect(parseProbe('__QCLOD_PROBE_BEGIN__\nos=Linux\n')).toBeNull()
  })

  test('x86_64 → x64, прочее → other; пустой claude — null; CRLF не мешает', () => {
    const text = '__QCLOD_PROBE_BEGIN__\r\nos=Linux\r\narch=x86_64\r\nclaudePath=\r\nlinger=\r\n__QCLOD_PROBE_END__\r\n'
    expect(parseProbe(text)).toMatchObject({ arch: 'x64', claudePath: null, claudeVersion: null, linger: 'unknown', libc: 'unknown' })
    expect(parseProbe(text.replace('x86_64', 'riscv64'))).toMatchObject({ arch: 'other', machine: 'riscv64' })
  })

  test('скрипт пробы ищет claude по порядку брифа и ставит метки', () => {
    expect(PROBE_SCRIPT).toContain('__QCLOD_PROBE_BEGIN__')
    expect(PROBE_SCRIPT).toContain('__QCLOD_PROBE_END__')
    expect(PROBE_SCRIPT).toContain(`-lc 'command -v claude'`)
    const order = ['-lc', '$HOME/.local/bin/claude', '$HOME/.claude/local/claude', '/usr/local/bin/claude']
    const at = order.map((s) => PROBE_SCRIPT.indexOf(s))
    expect(at.every((i) => i > -1)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(PROBE_SCRIPT).toContain('ldd --version 2>&1')
    expect(PROBE_SCRIPT).toContain('--version')
  })
})

describe('claudeStep', () => {
  test('ok', () => {
    expect(claudeStep(probe())).toEqual({ id: 'claude', state: 'ok', text: 'Claude Code 2.1.317' })
    expect(claudeStep(probe({ claudeVersion: MIN_SERVER_CLI })).state).toBe('ok')
    expect(MIN_SERVER_CLI).toBe('2.1.296')
  })

  test('нет claude', () => {
    expect(claudeStep(probe({ claudePath: null, claudeVersion: null }))).toEqual({
      id: 'claude',
      state: 'fail',
      text:
        'Claude Code на сервере не найден. Qclod сам его не устанавливает. Установите его на сервере: ' +
        'curl -fsSL https://claude.ai/install.sh | bash — и нажмите «Проверить снова».'
    })
  })

  test('старый: 2.1.295 — устарел', () => {
    expect(claudeStep(probe({ claudeVersion: '2.1.295' }))).toEqual({
      id: 'claude',
      state: 'fail',
      text: 'Claude Code на сервере устарел (2.1.295), нужен 2.1.296 или новее. Выполните на сервере: claude update'
    })
    expect(claudeStep(probe({ claudeVersion: '2.0.999' })).state).toBe('fail')
    expect(claudeStep(probe({ claudeVersion: '3.0.0' })).state).toBe('ok')
  })

  test('musl', () => {
    expect(claudeStep(probe({ libc: 'musl' }))).toEqual({
      id: 'claude',
      state: 'fail',
      text: 'Сервер на musl (например, Alpine) пока не поддерживается.'
    })
  })

  test('arch other', () => {
    expect(claudeStep({ ...probe({ arch: 'other' }), machine: 'riscv64' })).toEqual({
      id: 'claude',
      state: 'fail',
      text: 'Нужен Linux x64 или arm64, а у сервера Linux/riscv64.'
    })
    expect(claudeStep(probe({ os: 'FreeBSD' })).text).toBe('Нужен Linux x64 или arm64, а у сервера FreeBSD/x64.')
  })
})

describe('classifySshFailure', () => {
  test('четыре образца stderr', () => {
    const changed = [
      '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
      'Host key verification failed.'
    ].join('\n')
    expect(classifySshFailure(changed, 255)).toBe('hostKeyChanged')
    expect(classifySshFailure('demo@test.rebex.net: Permission denied (password,keyboard-interactive).', 255)).toBe(
      'authFailed'
    )
    expect(classifySshFailure('ssh: Could not resolve hostname nope: Name or service not known', 255)).toBe('unreachable')
    expect(classifySshFailure('ssh: connect to host 10.0.0.1 port 22: Connection timed out', 255)).toBe('unreachable')
    expect(classifySshFailure('ssh: connect to host 10.0.0.1 port 22: No route to host', 255)).toBe('unreachable')
    expect(classifySshFailure('ssh: connect to host 127.0.0.1 port 22: Connection refused', 255)).toBe('refused')
    expect(classifySshFailure('kex_exchange_identification: read: Connection reset by peer', 255)).toBe('other')
  })
})
