import { describe, expect, test } from 'vitest'
import { checkEnvironment } from '@main/setup/environment'
import { findAgent } from '@main/setup/findAgent'
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
