import { describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentNotFoundError, resolveExecutable } from '@main/sessions/resolveExecutable'

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

  test('расширение подбирается по PATHEXT в его порядке', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-bin-'))
    writeFileSync(join(dir, 'dual.cmd'), '', 'utf8')
    writeFileSync(join(dir, 'dual.exe'), '', 'utf8')
    expect(resolveExecutable('dual', { PATH: dir, PATHEXT: '.EXE;.CMD' })).toBe(
      join(dir, 'dual.exe')
    )
    expect(resolveExecutable('dual', { PATH: dir, PATHEXT: '.CMD;.EXE' })).toBe(
      join(dir, 'dual.cmd')
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
