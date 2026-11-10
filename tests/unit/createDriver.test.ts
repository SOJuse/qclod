import { afterEach, describe, expect, test } from 'vitest'
import { resolve } from 'node:path'
import { createDriverFactory } from '../../src/main/agent/createDriver'
import type { ToolPermissionContext } from '../../src/main/agent/permissionContext'

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
