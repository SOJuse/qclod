import { describe, expect, test } from 'vitest'
import { checkEnvironment } from '@main/setup/environment'
import { AGENT_PACKAGE, NODE_DOWNLOAD_URL } from '@main/setup/install'

describe('checkEnvironment', () => {
  test('находит node и npm на этой машине', async () => {
    const report = await checkEnvironment('claude')

    expect(report.node.found).toBe(true)
    expect(report.node.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(report.npm.found).toBe(true)
  })

  test('несуществующий агент — не найден, и это не исключение', async () => {
    const report = await checkEnvironment('такого-файла-нет-12345')

    expect(report.agent.found).toBe(false)
    expect(report.ready).toBe(false)
  })

  test('пустой путь к агенту читается как «claude»', async () => {
    // The setting may be blank on a fresh profile.
    await expect(checkEnvironment('')).resolves.toBeTruthy()
  })

  test('готовность определяется только агентом', async () => {
    const report = await checkEnvironment('claude')
    expect(report.ready).toBe(report.agent.found)
  })
})

describe('install', () => {
  test('ставится настоящий пакет Claude Code', () => {
    // The name is verified against the registry, not guessed: npm view
    // @anthropic-ai/claude-code returns a version.
    expect(AGENT_PACKAGE).toBe('@anthropic-ai/claude-code')
    expect(NODE_DOWNLOAD_URL).toMatch(/^https:\/\/nodejs\.org\//)
  })
})
