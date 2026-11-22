import { describe, expect, test } from 'vitest'
import { knownHostsPath, remoteCommand, shq, sshBaseArgs } from '@main/ssh/sshArgs'

function optionValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-o' && args[i + 1]!.startsWith(`${name}=`)) return args[i + 1]!.slice(name.length + 1)
  }
  return undefined
}

describe('sshBaseArgs', () => {
  test('на win32 нет ControlMaster', () => {
    const args = sshBaseArgs({ target: 'me@box' }, { platform: 'win32', userData: 'C:\\Users\\me\\AppData\\Roaming\\Qclod', batch: false })
    expect(args.join(' ')).not.toContain('ControlMaster')
    expect(args.join(' ')).not.toContain('ControlPath')
    expect(args.at(-1)).toBe('me@box')
  })

  test('на darwin ControlPath короче 104 символов при uid 501', () => {
    const args = sshBaseArgs(
      { target: 'me@box' },
      { platform: 'darwin', userData: '/Users/me/Library/Application Support/Qclod', uid: 501, batch: false }
    )
    expect(optionValue(args, 'ControlMaster')).toBe('auto')
    expect(optionValue(args, 'ControlPersist')).toBe('10m')
    const path = optionValue(args, 'ControlPath')!
    expect(path).toBe('/tmp/qclod-501/cm-%C')
    // %C is a 40-character hash.
    expect(path.replace('%C', 'x'.repeat(40)).length).toBeLessThan(104)
  })

  test('путь userData с пробелом стоит в кавычках внутри UserKnownHostsFile', () => {
    const args = sshBaseArgs(
      { target: 'me@box' },
      { platform: 'darwin', userData: '/Users/me/Library/Application Support/Qclod', uid: 501, batch: false }
    )
    expect(optionValue(args, 'UserKnownHostsFile')).toBe(
      '"/Users/me/Library/Application Support/Qclod/ssh/known_hosts" ~/.ssh/known_hosts'
    )
    const win = sshBaseArgs({ target: 'me@box' }, { platform: 'win32', userData: 'C:\\Users\\a b\\Qclod', batch: false })
    expect(optionValue(win, 'UserKnownHostsFile')).toBe('"C:/Users/a b/Qclod/ssh/known_hosts" ~/.ssh/known_hosts')
  })

  test('ForwardAgent=no и остальные постоянные опции есть всегда', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const args = sshBaseArgs({ target: 'box' }, { platform, userData: '/u', uid: 1000, batch: true })
      expect(optionValue(args, 'ForwardAgent')).toBe('no')
      expect(optionValue(args, 'ClearAllForwardings')).toBe('yes')
      expect(optionValue(args, 'StrictHostKeyChecking')).toBe('ask')
      expect(optionValue(args, 'NumberOfPasswordPrompts')).toBe('1')
      expect(optionValue(args, 'BatchMode')).toBe('no')
      expect(optionValue(args, 'ServerAliveInterval')).toBe('15')
      expect(optionValue(args, 'ServerAliveCountMax')).toBe('3')
      expect(args[0]).toBe('-T')
    }
  })

  test('-tt при tty, -p и -i при порте и ключе, хост последним', () => {
    const args = sshBaseArgs(
      { target: 'me@box', port: 2222, identityFile: '/k/id' },
      { platform: 'linux', userData: '/u', uid: 1000, batch: false, tty: true }
    )
    expect(args[0]).toBe('-tt')
    expect(args).not.toContain('-T')
    expect(args[args.indexOf('-p') + 1]).toBe('2222')
    expect(args[args.indexOf('-i') + 1]).toBe('/k/id')
    expect(args.at(-1)).toBe('me@box')
  })
})

describe('shq и remoteCommand', () => {
  test("shq(\"it's\") даёт 'it'\\''s'", () => {
    expect(shq("it's")).toBe("'it'\\''s'")
    expect(shq('')).toBe("''")
    expect(shq('a b&$x')).toBe("'a b&$x'")
  })

  test('remoteCommand склеивает части в одну строку, ~/ остаётся вне кавычек', () => {
    expect(remoteCommand(['~/.qclod/bin/qclod-relay', 'attach'])).toBe("~/'.qclod/bin/qclod-relay' 'attach'")
    expect(remoteCommand(["/x/it's"])).toBe("'/x/it'\\''s'")
    expect(remoteCommand(['sh', '-s'])).toBe("'sh' '-s'")
  })

  test('knownHostsPath — userData/ssh/known_hosts', () => {
    expect(knownHostsPath('/u').replace(/\\/g, '/')).toBe('/u/ssh/known_hosts')
  })
})
