import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  macAgentLines,
  macCommandFile,
  openAgentTerminal,
  openInMacTerminal,
  shq,
  type ConsoleSpawn
} from '@main/system/console'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'qclod-console-'))
  dirs.push(d)
  return d
}
const fakeSpawn = () => {
  const unref = vi.fn()
  const fn = vi.fn(() => ({ on: vi.fn(), unref }))
  return { fn: fn as unknown as ConsoleSpawn, calls: fn.mock.calls as unknown as Array<[string, string[]]>, unref }
}

describe('shq', () => {
  test('одинарные кавычки; внутренняя кавычка закрывает, экранируется и открывает снова', () => {
    expect(shq('abc')).toBe("'abc'")
    expect(shq("it's")).toBe("'it'\\''s'")
    expect(shq('/Users/A B/$HOME')).toBe("'/Users/A B/$HOME'")
  })
})

describe('macCommandFile', () => {
  test('шебанг, самоудаление, строки; путь с кавычкой и пробелом экранирован', () => {
    const text = macCommandFile(macAgentLines("/Users/o'neil/my app/claude", "/Users/o'neil/проект x"))
    expect(text.startsWith('#!/bin/zsh\nrm -f -- "$0"\n')).toBe(true)
    expect(text).toContain("cd '/Users/o'\\''neil/проект x' || exit 1")
    expect(text).toContain("exec '/Users/o'\\''neil/my app/claude'")
    expect(text.endsWith('\n')).toBe(true)
  })

  test('старый cli.js запускается через node', () => {
    expect(macAgentLines('/a/cli.js', '/p')[1]).toBe("exec node '/a/cli.js'")
  })
})

describe('openInMacTerminal', () => {
  test('файл qclod-….command с правами 0700 и open -a Terminal', () => {
    const dir = tmp()
    const { fn, calls, unref } = fakeSpawn()
    openInMacTerminal('#!/bin/zsh\necho hi\n', fn, dir)
    const [file, args] = calls[0]!
    expect(file).toBe('open')
    expect(args.slice(0, 2)).toEqual(['-a', 'Terminal'])
    expect(args[2]).toMatch(/qclod-[0-9a-f]{16}\.command$/)
    expect(readFileSync(args[2]!, 'utf8')).toBe('#!/bin/zsh\necho hi\n')
    if (process.platform !== 'win32') expect(statSync(args[2]!).mode & 0o777).toBe(0o700)
    expect(unref).toHaveBeenCalled()
  })

  test('два вызова — два разных файла', () => {
    const dir = tmp()
    const { fn, calls } = fakeSpawn()
    openInMacTerminal('a', fn, dir)
    openInMacTerminal('a', fn, dir)
    expect(calls[0]![1][2]).not.toBe(calls[1]![1][2])
  })
})

describe('openAgentTerminal', () => {
  test('на darwin — Terminal, не cmd.exe', () => {
    const { fn, calls } = fakeSpawn()
    openAgentTerminal('/Users/a/.local/bin/claude', '/Users/a/p', fn, 'darwin')
    expect(calls[0]![0]).toBe('open')
    rmSync(calls[0]![1][2]!, { force: true })
  })

  test('на Windows — cmd.exe, как раньше', () => {
    const { fn, calls } = fakeSpawn()
    openAgentTerminal('C:\\a\\claude.exe', 'C:\\p', fn, 'win32')
    expect(calls[0]![0]).toBe('cmd.exe')
  })
})
