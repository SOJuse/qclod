import { afterEach, describe, expect, test, vi } from 'vitest'
import { resolve } from 'node:path'
import { createDriverFactory, driverChoice, REAL_AGENT_REFUSED } from '../../src/main/agent/createDriver'
import type { ToolPermissionContext } from '../../src/main/agent/permissionContext'

/** The real driver is never reached from a test: if the guard ever slips, this spy says so. */
const realDriver = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/agent/sdkDriver', () => ({ createSdkDriver: realDriver }))

const FIXTURE = resolve(__dirname, '../fixtures/fake-sdk/index.mjs')

afterEach(() => {
  delete process.env['QCLOD_FAKE_SDK']
  delete process.env['QCLOD_FAKE_SDK_SCRIPT']
})

describe('createDriverFactory: e2e-режим', () => {
  test('фикстура в e2e-режиме передаёт toolUseID и signal, а не {}', async () => {
    process.env['QCLOD_FAKE_SDK'] = FIXTURE
    process.env['QCLOD_FAKE_SDK_SCRIPT'] = JSON.stringify({
      steps: [{ kind: 'askPermission', name: 'Bash', input: { command: 'npm test' } }]
    })

    const seen: ToolPermissionContext[] = []
    const driver = await createDriverFactory()({
      cwd: 'C:/проект',
      executablePath: 'C:/bin/claude.exe',
      canUseTool: async (_name, _input, context) => {
        seen.push(context)
        return { behavior: 'allow' }
      }
    })

    const toolUseIds: string[] = []
    for await (const message of driver.messages) {
      const m = message as Record<string, unknown>
      if (m['type'] === 'assistant') {
        const content = (m['message'] as { content: Array<Record<string, unknown>> }).content
        for (const block of content) if (block['type'] === 'tool_use') toolUseIds.push(String(block['id']))
      }
      if (m['type'] === 'result') break
    }
    await driver.dispose()

    expect(seen).toHaveLength(1)
    expect(seen[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0]!.toolUseId).toBeTruthy()
    expect(toolUseIds).toEqual([seen[0]!.toolUseId])
  })
})

describe('driverChoice: тестовая сборка не запускает настоящего агента', () => {
  test('сборка с тестовыми швами без QCLOD_FAKE_SDK — отказ, с QCLOD_ALLOW_REAL=1 — настоящий', () => {
    expect(driverChoice(true, {})).toBe('refuse')
    expect(driverChoice(true, { QCLOD_FAKE_SDK: '' })).toBe('refuse')
    expect(driverChoice(true, { QCLOD_ALLOW_REAL: 'yes' })).toBe('refuse')
    expect(driverChoice(true, { QCLOD_ALLOW_REAL: '1' })).toBe('real')
    expect(driverChoice(true, { QCLOD_FAKE_SDK: FIXTURE })).toBe('fake')
  })

  test('релизная сборка всегда настоящая, переменные ей безразличны', () => {
    expect(driverChoice(false, {})).toBe('real')
    expect(driverChoice(false, { QCLOD_FAKE_SDK: FIXTURE })).toBe('real')
  })

  test('фабрика тестовой сборки без фикстуры отказывает понятной ошибкой и ничего не запускает', async () => {
    delete process.env['QCLOD_ALLOW_REAL']
    await expect(
      createDriverFactory()({} as unknown as Parameters<ReturnType<typeof createDriverFactory>>[0])
    ).rejects.toThrow(REAL_AGENT_REFUSED)
    expect(realDriver).not.toHaveBeenCalled()
  })
})
