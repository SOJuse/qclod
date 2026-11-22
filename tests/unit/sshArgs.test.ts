import { describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateDir, isSafeSshTarget, knownHostsPath, remoteCommand, shq, sshBaseArgs, type PrivateDirFs } from '@main/ssh/sshArgs'

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

describe('isSafeSshTarget (I10, CVE-2023-51385)', () => {
  test('обычные цели проходят', () => {
    for (const t of ['me@home.lan', 'box', 'me@10.0.0.2', 'me@[fe80::1%eth0]', 'u+x@host-1.example.com', 'host_2']) {
      expect(isSafeSshTarget(t)).toBe(true)
    }
  })

  test('метасимволы оболочки, пробелы и ведущий - — нет', () => {
    for (const t of ['-oProxyCommand=calc', "me@ho'st", 'a;b', '$(id)@h', 'a' + String.fromCharCode(96) + 'id' + String.fromCharCode(96),'me@host\n', 'a b', 'a|b', 'a&b', '"x"', 'a\\b', '', 'h>f']) {
      expect(isSafeSshTarget(t)).toBe(false)
    }
  })
})

describe('ensurePrivateDir (I9)', () => {
  const st = (over: Partial<{ link: boolean; dir: boolean; uid: number; mode: number }>) => ({
    isSymbolicLink: () => over.link ?? false,
    isDirectory: () => over.dir ?? true,
    uid: over.uid ?? 501,
    mode: over.mode ?? 0o40700
  })
  const fs = (over: Parameters<typeof st>[0]): PrivateDirFs => ({ mkdirSync: () => undefined, lstatSync: () => st(over) })

  test('своя папка 0700 — да; ссылка, чужая, открытая другим, не папка — отказ', () => {
    expect(() => ensurePrivateDir('/tmp/qclod-501', 501, fs({}))).not.toThrow()
    expect(() => ensurePrivateDir('/tmp/qclod-501', 501, fs({ link: true }))).toThrow(/не папка/)
    expect(() => ensurePrivateDir('/tmp/qclod-501', 501, fs({ dir: false }))).toThrow(/не папка/)
    expect(() => ensurePrivateDir('/tmp/qclod-501', 501, fs({ uid: 0 }))).toThrow(/другому пользователю/)
    expect(() => ensurePrivateDir('/tmp/qclod-501', 501, fs({ mode: 0o40755 }))).toThrow(/открыта другим/)
    expect(() => ensurePrivateDir('/tmp/qclod-501', 501, fs({ mode: 0o40770 }))).toThrow(/открыта другим/)
  })

  test.skipIf(process.platform === 'win32')('POSIX: настоящая ссылка на чужую папку и папка 0755 — отказ', () => {
    const root = mkdtempSync(join(tmpdir(), 'qclod-priv-'))
    try {
      const uid = process.getuid!()
      const real = join(root, 'real')
      ensurePrivateDir(real, uid)
      const link = join(root, 'link')
      symlinkSync(real, link)
      expect(() => ensurePrivateDir(link, uid)).toThrow(/не папка/)
      chmodSync(real, 0o755)
      expect(() => ensurePrivateDir(real, uid)).toThrow(/открыта другим/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
