import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOOK_LAUNCHER_NAME,
  unpackedPath,
  writeHookLauncher
} from '@main/sessions/hookLauncher'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qclod-launcher-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeHookLauncher', () => {
  test('создаёт .cmd рядом с остальными данными приложения', () => {
    const path = writeHookLauncher(dir, 'C:/app/electron.exe', 'C:/app/bin/qclod-hook.js')
    expect(path).toBe(join(dir, HOOK_LAUNCHER_NAME))
    expect(existsSync(path)).toBe(true)
  })

  test('выставляет ELECTRON_RUN_AS_NODE', () => {
    // Without it the executable starts as an Electron app and opens a window
    // instead of running the hook script.
    const body = readFileSync(
      writeHookLauncher(dir, 'C:/app/electron.exe', 'C:/app/bin/qclod-hook.js'),
      'utf8'
    )
    expect(body).toContain('ELECTRON_RUN_AS_NODE=1')
  })

  test('пути берутся в кавычки и аргументы прокидываются', () => {
    const body = readFileSync(
      writeHookLauncher(dir, 'C:/Program Files/Qclod/Qclod.exe', 'C:/Program Files/Qclod/hook.js'),
      'utf8'
    )
    expect(body).toContain('"C:/Program Files/Qclod/Qclod.exe"')
    expect(body).toContain('"C:/Program Files/Qclod/hook.js"')
    expect(body).toContain('%*')
  })

  test('повторный вызов перезаписывает и не падает', () => {
    writeHookLauncher(dir, 'a.exe', 'a.js')
    const path = writeHookLauncher(dir, 'b.exe', 'b.js')
    expect(readFileSync(path, 'utf8')).toContain('"b.exe"')
  })
})

describe('unpackedPath', () => {
  test('путь внутри asar переводится в распакованный', () => {
    // ELECTRON_RUN_AS_NODE does not read scripts out of an asar archive, so
    // bin/ is unpacked at build time and the path has to follow.
    expect(unpackedPath('C:/Program Files/Qclod/resources/app.asar/bin/qclod-hook.js')).toBe(
      'C:/Program Files/Qclod/resources/app.asar.unpacked/bin/qclod-hook.js'
    )
  })

  test('обычный путь не меняется', () => {
    expect(unpackedPath('C:/dev/qclod/bin/qclod-hook.js')).toBe('C:/dev/qclod/bin/qclod-hook.js')
  })

  test('обратные слеши тоже обрабатываются', () => {
    const windowsStyle = ['C:', 'app', 'resources', 'app.asar', 'bin', 'hook.js'].join('\\')
    const expected = ['C:', 'app', 'resources', 'app.asar.unpacked', 'bin', 'hook.js'].join('\\')
    expect(unpackedPath(windowsStyle)).toBe(expected)
  })

  test('уже распакованный путь не ломается', () => {
    const path = 'C:/app/resources/app.asar.unpacked/bin/hook.js'
    expect(unpackedPath(path)).toBe(path)
  })
})
