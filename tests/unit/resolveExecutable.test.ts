import { describe, expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentNotFoundError, resolveExecutable, unwrapShim } from '@main/agent/resolveExecutable'
import { npmFixture } from './npmFixture'

describe('resolveExecutable', () => {
  test('абсолютный путь к существующему файлу возвращается как есть', () => {
    expect(resolveExecutable(process.execPath, {})).toBe(process.execPath)
  })

  test('абсолютный путь к несуществующему файлу — понятная ошибка', () => {
    expect(() => resolveExecutable('C:\\nope\\missing.exe', {})).toThrow(AgentNotFoundError)
  })

  test('голое имя находится по PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-bin-'))
    writeFileSync(join(dir, 'myagent.exe'), '', 'utf8')
    const resolved = resolveExecutable('myagent', { PATH: dir, PATHEXT: '.EXE;.CMD' })
    expect(resolved).toBe(join(dir, 'myagent.exe'))
  })

  test('при .CMD раньше .EXE в PATHEXT всё равно берётся .exe', () => {
    // A .cmd cannot be started without a shell, so PATHEXT order no longer
    // decides between it and an .exe.
    const dir = mkdtempSync(join(tmpdir(), 'qclod-bin-'))
    writeFileSync(join(dir, 'dual.cmd'), '', 'utf8')
    writeFileSync(join(dir, 'dual.exe'), '', 'utf8')
    expect(resolveExecutable('dual', { PATH: dir, PATHEXT: '.CMD;.EXE' })).toBe(
      join(dir, 'dual.exe')
    )
  })

  test('имя с уже указанным расширением находится без подбора', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-bin-'))
    writeFileSync(join(dir, 'exact.exe'), '', 'utf8')
    expect(resolveExecutable('exact.exe', { PATH: dir, PATHEXT: '.EXE' })).toBe(
      join(dir, 'exact.exe')
    )
  })

  test('ничего не найдено — ошибка называет имя и говорит, что делать', () => {
    let caught: unknown
    try {
      resolveExecutable('definitely-not-installed', { PATH: '', PATHEXT: '.EXE' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AgentNotFoundError)
    expect((caught as Error).message).toContain('definitely-not-installed')
  })

  test('пустое имя — ошибка, а не поиск пустой строки', () => {
    expect(() => resolveExecutable('   ', {})).toThrow(AgentNotFoundError)
  })
})

describe('npm-установка Claude Code', () => {
  const PATHEXT = '.COM;.EXE;.BAT;.CMD'
  const exePath = (root: string): string =>
    join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
  const run = (file: string): string =>
    execFileSync(file, ['--version'], { encoding: 'utf8', windowsHide: true }).trim()

  test('npm-установка: находится настоящий claude.exe, а не sh-скрипт и не .cmd', () => {
    const root = mkdtempSync(join(tmpdir(), 'qclod-npm-'))
    npmFixture(root, 'exe')
    expect(resolveExecutable('claude', { PATH: root, PATHEXT })).toBe(exePath(root))
  })

  test('найденный файл действительно запускается без shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'qclod-npm-'))
    npmFixture(root, 'exe')
    // node.exe under another name: it answers --version with its own version.
    expect(run(resolveExecutable('claude', { PATH: root, PATHEXT }))).toBe(process.version)
  })

  test('старый npm-пакет: обёртка разворачивается в cli.js', () => {
    const root = mkdtempSync(join(tmpdir(), 'qclod-npm-'))
    const cli = npmFixture(root, 'js')
    expect(cli).toBe(join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'))
    expect(unwrapShim(join(root, 'claude.cmd'))).toBe(cli)
    expect(resolveExecutable('claude', { PATH: root, PATHEXT })).toBe(cli)
  })

  test('путь с пробелом и кириллицей', () => {
    // C:\Users\Иван Петров\AppData\Roaming\npm\claude.cmd
    const root = mkdtempSync(join(tmpdir(), 'Иван Петров npm-'))
    npmFixture(root, 'exe')
    const resolved = resolveExecutable('claude', { PATH: root, PATHEXT })
    expect(resolved).toBe(exePath(root))
    expect(run(resolved)).toBe(process.version)
    // The settings field may hold the wrapper itself.
    expect(resolveExecutable(join(root, 'claude.cmd'), { PATHEXT })).toBe(exePath(root))
  })

  test('свой префикс npm где-то в PATH', () => {
    const base = mkdtempSync(join(tmpdir(), 'qclod-prefix-'))
    const other = join(base, 'tools')
    const root = join(base, 'my npm prefix')
    mkdirSync(other)
    mkdirSync(root)
    npmFixture(root, 'exe')
    expect(resolveExecutable('claude', { PATH: `${other};"${root}"`, PATHEXT })).toBe(
      exePath(root)
    )
  })

  test('.cmd, который не обёртка npm, — понятная ошибка, а не EINVAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-bin-'))
    writeFileSync(join(dir, 'claude.cmd'), '@echo off\r\nnode "C:\\somewhere\\x.js" %*\r\n', 'utf8')
    for (const requested of ['claude', join(dir, 'claude.cmd')]) {
      let caught: unknown
      try {
        resolveExecutable(requested, { PATH: dir, PATHEXT })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(AgentNotFoundError)
      expect((caught as Error).message).toContain(join(dir, 'claude.cmd'))
      expect((caught as Error).message).toContain('напрямую')
    }
  })

  test('обёртка, чей файл пропал, не останавливает поиск по PATH', () => {
    const broken = mkdtempSync(join(tmpdir(), 'qclod-broken-'))
    const good = mkdtempSync(join(tmpdir(), 'qclod-npm-'))
    npmFixture(broken, 'exe')
    rmSync(exePath(broken))
    npmFixture(good, 'exe')
    expect(resolveExecutable('claude', { PATH: `${broken};${good}`, PATHEXT })).toBe(
      exePath(good)
    )
  })
})
