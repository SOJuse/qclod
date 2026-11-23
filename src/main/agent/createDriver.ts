import type { AgentDriver, DriverFactory, DriverOptions } from './driver'
import { toPermissionContext } from './permissionContext'
import { withProxyEnv } from '../vpn/proxyEnv'

/** What a test build says instead of starting the real agent. */
export const REAL_AGENT_REFUSED =
  'Тестовая сборка не запускает настоящий Claude Code: задайте QCLOD_FAKE_SDK ' +
  '(путь к tests/fixtures/fake-sdk/index.mjs) или QCLOD_ALLOW_REAL=1, если настоящий агент нужен намеренно.'

/**
 * Which agent a build may start. A release build always starts the real one
 * (it has no seams). A test build starts the fixture when QCLOD_FAKE_SDK
 * names it, and otherwise refuses, unless QCLOD_ALLOW_REAL=1 says the real
 * agent is wanted on purpose: a check script that forgot the variable must
 * not spend the owner's subscription or act on the repository.
 */
export function driverChoice(
  seams: boolean,
  env: Record<string, string | undefined>
): 'fake' | 'real' | 'refuse' {
  if (!seams) return 'real'
  if (env['QCLOD_FAKE_SDK']) return 'fake'
  return env['QCLOD_ALLOW_REAL'] === '1' ? 'real' : 'refuse'
}

/**
 * Picks the session implementation.
 *
 * In the e2e build an env var can point it at the test fixture; the e2e config
 * sets it and nothing else does. Without it the real SDK is used. This is the
 * seam that lets the app be driven end to end without an account, a network
 * or a token spent. A release build does not contain it at all
 * (buildFlags.d.ts), so a user cannot land in it by accident.
 */
export function createDriverFactory(
  opts: {
    relay?: DriverFactory
    /** 1.0.1: vpn — the proxy env of a new local Claude Code process; null — none. Server chats never get it. */
    localProxyEnv?: () => Promise<Record<string, string> | null>
  } = {}
): DriverFactory {
  const local = localDriverFactory()
  // Stage 6: a server chat's agent runs in its relay; nothing local is started for it.
  return async (options) => {
    if (!options.server) {
      const proxy = opts.localProxyEnv ? await opts.localProxyEnv() : null
      const env = withProxyEnv(options.env ?? process.env, proxy)
      if (__QCLOD_TEST_SEAMS__) {
        // e2e and the live check read what the agent's process was given.
        ;(globalThis as { __qclodAgentProxy?: string | null }).__qclodAgentProxy = env?.['HTTPS_PROXY'] ?? null
      }
      return local(env ? { ...options, env } : options)
    }
    if (!opts.relay) return Promise.reject(new Error('Серверные чаты недоступны в этом запуске'))
    return opts.relay(options)
  }
}

function localDriverFactory(): DriverFactory {
  const choice = driverChoice(__QCLOD_TEST_SEAMS__, process.env)
  const fakePath = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_SDK'] : undefined

  if (__QCLOD_TEST_SEAMS__ && choice === 'refuse') {
    return async (): Promise<AgentDriver> => {
      throw new Error(REAL_AGENT_REFUSED)
    }
  }

  if (choice === 'fake' && fakePath) {
    return async (options: DriverOptions): Promise<AgentDriver> => {
      const { pathToFileURL } = await import('node:url')
      const module = (await import(pathToFileURL(fakePath).href)) as {
        createFakeSdk: (script: unknown) => AgentDriver
      }
      const script = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_SDK_SCRIPT'] : undefined
      const parsed = script ? (JSON.parse(script) as Record<string, unknown>) : {}
      return module.createFakeSdk({
        ...parsed,
        // The fixture must ask the same gate the real session asks, or an e2e
        // run would approve everything by itself and prove nothing.
        // It is also handed what the real SDK hands it — the call's id and
        // signal — read the same way the real driver reads them.
        canUseTool: (toolName: string, input: Record<string, unknown>, opts: unknown) =>
          options.canUseTool(toolName, input, toPermissionContext(opts)),
        // The model the tab asked for at launch is the one the fixture starts in,
        // as the real CLI does with --model.
        init: {
          cwd: options.cwd,
          ...(options.model ? { model: options.model } : {}),
          ...(parsed['init'] as object)
        }
      })
    }
  }

  return async (options: DriverOptions): Promise<AgentDriver> => {
    // e2e checks that a refused test build never got here.
    if (__QCLOD_TEST_SEAMS__) {
      const g = globalThis as { __qclodRealAgentStarts?: number }
      g.__qclodRealAgentStarts = (g.__qclodRealAgentStarts ?? 0) + 1
    }
    const { createSdkDriver } = await import('./sdkDriver')
    return createSdkDriver(options)
  }
}
