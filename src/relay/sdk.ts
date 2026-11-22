import { createRequire } from 'node:module'
import { listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentDriver, DriverFactory, DriverOptions } from '../main/agent/driver'
import { toPermissionContext } from '../main/agent/permissionContext'
import { createSdkDriver } from '../main/agent/sdkDriver'

/** The server's past conversations, from the bundled SDK. */
export const relayListSessions = (options: { dir: string }) =>
  listSessions(options) as unknown as Promise<
    Array<{ sessionId: string; summary: string; lastModified: number; customTitle?: string; firstPrompt?: string }>
  >

/**
 * The relay's driver factory. A release relay has the SDK bundled in
 * statically — a single-executable binary has no node_modules to import from
 * at run time — and hands its `query` to the same driver Qclod uses.
 *
 * A test build of the relay (out/relay-e2e) starts the fixture QCLOD_FAKE_SDK
 * names, and otherwise refuses unless QCLOD_ALLOW_REAL=1, as Qclod's own test
 * build does (createDriver.ts). A release build has neither branch.
 */
export function relayDriverFactory(): DriverFactory {
  if (__QCLOD_TEST_SEAMS__) {
    const fakePath = process.env['QCLOD_FAKE_SDK']
    if (fakePath) {
      // In a single-executable binary only require from a real path loads a file
      // module; Node 22 requires an ES module without top-level await.
      const load = createRequire(process.execPath)
      return (options: DriverOptions): AgentDriver => {
        const module = load(fakePath) as { createFakeSdk: (script: unknown) => AgentDriver }
        const script = process.env['QCLOD_FAKE_SDK_SCRIPT']
        const parsed = script ? (JSON.parse(script) as Record<string, unknown>) : {}
        return module.createFakeSdk({
          ...parsed,
          canUseTool: (toolName: string, input: Record<string, unknown>, opts: unknown) =>
            options.canUseTool(toolName, input, toPermissionContext(opts)),
          init: { cwd: options.cwd, ...(options.model ? { model: options.model } : {}), ...(parsed['init'] as object) }
        })
      }
    }
    if (process.env['QCLOD_ALLOW_REAL'] !== '1') {
      return async (): Promise<AgentDriver> => {
        throw new Error('Тестовая сборка посредника не запускает настоящий Claude Code: задайте QCLOD_FAKE_SDK')
      }
    }
  }
  return (options) => createSdkDriver(options, { query })
}
