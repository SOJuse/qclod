import { describe, expect, test } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { npmFixture } from './npmFixture'
import { checkEnvironment } from '@main/setup/environment'
import { findAgent, locateAgent } from '@main/setup/findAgent'
import { detectInstallMethod, WINGET_ID, NPM_PACKAGE } from '@main/setup/install'

describe('checkEnvironment', () => {
  test('находит установленный агент и его версию', async () => {
    const report = await checkEnvironment('claude')

    expect(report.agent.found).toBe(true)
    expect(report.agent.path).toBeTruthy()
    expect(report.ready).toBe(true)
  })

  test('несуществующий путь — не найден, и это не исключение', async () => {
    const report = await checkEnvironment('C:/нет/такого/claude.exe')

    expect(report.agent.found).toBe(false)
    expect(report.ready).toBe(false)
  })

  test('версия старого npm-пакета (cli.js) спрашивается через node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qclod-npm-'))
    const cli = npmFixture(root, 'js')
    const report = await checkEnvironment(cli)

    expect(report.agent.path).toBe(cli)
    expect(report.agent.version).toBe('1.0.99')
  })

  test('пустая настройка читается как «claude»', async () => {
    const report = await checkEnvironment('')
    expect(report.ready).toBe(true)
  })
})

describe('findAgent', () => {
  test('находит агент, даже если его нет в PATH', () => {
    // A process inherits PATH at start, so an agent installed a moment ago is
    // invisible to it; the known install locations are checked directly.
    const withoutPath = { ...process.env, PATH: '', Path: '' }
    expect(findAgent('claude', withoutPath)).toBeTruthy()
  })

  test('findAgent без PATH находит npm-установку в APPDATA и отдаёт exe', () => {
    const appData = mkdtempSync(join(tmpdir(), 'qclod-appdata-'))
    const npm = join(appData, 'npm')
    mkdirSync(npm)
    const exe = npmFixture(npm, 'exe')
    const env = { APPDATA: appData, PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    expect(findAgent('claude', env)).toBe(exe)
    expect(exe).toBe(
      join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    )
  })

  test('findAgent не отдаёт npm-ский sh-скрипт без расширения', () => {
    const appData = mkdtempSync(join(tmpdir(), 'qclod-appdata-'))
    const npm = join(appData, 'npm')
    mkdirSync(npm)
    writeFileSync(join(npm, 'claude'), '#!/bin/sh\n', 'utf8')
    expect(findAgent('claude', { APPDATA: appData, PATH: '' })).toBeNull()
  })

  test('полный путь, которого нет, не подменяется другим агентом', () => {
    // Someone who typed a path meant that path.
    expect(findAgent('C:/нет/такого/claude.exe', process.env)).toBeNull()
  })
})

describe('detectInstallMethod', () => {
  test('на Windows выбирает winget — он уже стоит у всех', async () => {
    // Detected by running it: winget is a Store app alias whose file cannot
    // even be stat-ed from here, though spawning it works.
    await expect(detectInstallMethod()).resolves.toBe('winget')
  })

  test('имена пакетов — настоящие, сверены с источниками', () => {
    // winget: Anthropic PBC / Claude Code. npm: the published package.
    expect(WINGET_ID).toBe('Anthropic.ClaudeCode')
    expect(NPM_PACKAGE).toBe('@anthropic-ai/claude-code')
  })
})

function brokenShimEnv(): NodeJS.ProcessEnv {
  const appData = mkdtempSync(join(tmpdir(), 'qclod-shim-'))
  const npm = join(appData, 'npm')
  mkdirSync(npm)
  writeFileSync(
    join(npm, 'claude.cmd'),
    '@ECHO off\r\n"%dp0%\\node_modules\\x\\missing.exe" %*\r\n',
    'utf8'
  )
  return { APPDATA: appData, PATH: '', PATHEXT: '.EXE;.CMD' }
}

describe('причина «агент не найден»', () => {
  test('locateAgent отдаёт текст про .cmd-обёртку', () => {
    expect(() => locateAgent('claude', brokenShimEnv())).toThrow(/\.cmd-обёртка/)
  })

  test('checkEnvironment показывает причину', async () => {
    const report = await checkEnvironment('claude', {
      env: brokenShimEnv(),
      detect: async () => 'winget'
    })
    expect(report.agent.found).toBe(false)
    expect(report.agent.problem).toMatch(/\.cmd-обёртка/)
  })

  test('неверный путь в настройках назван', async () => {
    const report = await checkEnvironment('C:/нет/такого/claude.exe', {
      env: { PATH: '' },
      detect: async () => 'winget'
    })
    expect(report.agent.problem).toContain('C:/нет/такого/claude.exe')
  })

  test('на чистой машине причины нет', async () => {
    const report = await checkEnvironment('claude', {
      env: { PATH: '' },
      detect: async () => null
    })
    expect(report.agent.found).toBe(false)
    expect(report.agent.problem).toBeUndefined()
  })
})
