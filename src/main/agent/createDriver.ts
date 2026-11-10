import type { AgentDriver, DriverFactory, DriverOptions } from './driver'
import { toPermissionContext } from './permissionContext'

/**
 * Picks the session implementation.
 *
 * In the e2e build an env var can point it at the test fixture; the e2e config
 * sets it and nothing else does. Without it the real SDK is used. This is the
 * seam that lets the app be driven end to end without an account, a network
 * or a token spent. A release build does not contain it at all
 * (buildFlags.d.ts), so a user cannot land in it by accident.
 */
export function createDriverFactory(): DriverFactory {
  const fakePath = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_SDK'] : undefined

  if (fakePath) {
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
    const { createSdkDriver } = await import('./sdkDriver')
    return createSdkDriver(options)
  }
}
