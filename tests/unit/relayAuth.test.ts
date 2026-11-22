import { describe, expect, test } from 'vitest'
import { authStatus, parseClaudeVersion, parseServerAuth } from '../../src/relay/auth'

describe('аккаунт Claude на сервере', () => {
  test('вошёл: почта и тариф', () => {
    // The fields Qclod already reads locally (auth.test.ts) and subscriptionType, as accountInfo() names it (probe 07).
    expect(
      parseServerAuth('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","subscriptionType":"max"}')
    ).toEqual({ loggedIn: true, email: 'a@b.c', plan: 'max' })
  })

  test('loggedIn:false', () => {
    expect(parseServerAuth('{"loggedIn":false}')).toEqual({ loggedIn: false })
  })

  test('мусор даёт loggedIn: null', () => {
    expect(parseServerAuth('Error: unknown command')).toEqual({ loggedIn: null })
    expect(parseServerAuth('{"loggedIn":"yes"}')).toEqual({ loggedIn: null })
    expect(parseServerAuth('')).toEqual({ loggedIn: null })
  })

  test('шум до JSON не мешает', () => {
    expect(parseServerAuth('warning: x\n{"loggedIn":true,"email":"a@b.c"}\n')).toEqual({ loggedIn: true, email: 'a@b.c' })
  })

  test('версия claude', () => {
    expect(parseClaudeVersion('2.1.317 (Claude Code)\n')).toBe('2.1.317')
    expect(parseClaudeVersion('нет')).toBeNull()
  })

  test('auth.status: путь, версия, вход; без claude — всё null', async () => {
    const calls: string[] = []
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '))
      if (args[0] === '--version') return { code: 0, stdout: '2.1.317 (Claude Code)' }
      return { code: 1, stdout: '{"loggedIn":false}' }
    }
    expect(await authStatus(run, '/home/u/.local/bin/claude')).toEqual({
      loggedIn: false,
      claudePath: '/home/u/.local/bin/claude',
      claudeVersion: '2.1.317'
    })
    expect(calls).toEqual(['/home/u/.local/bin/claude auth status --json', '/home/u/.local/bin/claude --version'])
    expect(await authStatus(run, null)).toEqual({ loggedIn: null, claudePath: null, claudeVersion: null })
  })
})
