import type { AgentDriver, DriverFactory, DriverOptions } from './driver'

/**
 * Picks the session implementation.
 *
 * `QCLOD_FAKE_SDK` points at the test fixture and is set by the e2e config and
 * nowhere else. Without it the real SDK is used. This is the single seam that
 * lets the packaged app be driven end to end without an account, a network or
 * a token spent — and it is an env var rather than a setting precisely so a
 * user cannot land in it by accident.
 */
export function createDriverFactory(): DriverFactory {
  const fakePath = process.env['QCLOD_FAKE_SDK']

  if (fakePath) {
    return async (options: DriverOptions): Promise<AgentDriver> => {
      const { pathToFileURL } = await import('node:url')
      const module = (await import(pathToFileURL(fakePath).href)) as {
        createFakeSdk: (script: unknown) => AgentDriver
      }
      const script = process.env['QCLOD_FAKE_SDK_SCRIPT']
      const parsed = script ? (JSON.parse(script) as Record<string, unknown>) : {}
      return module.createFakeSdk({ ...parsed, init: { cwd: options.cwd, ...(parsed['init'] as object) } })
    }
  }

  return async (options: DriverOptions): Promise<AgentDriver> => {
    const { createSdkDriver } = await import('./sdkDriver')
    return createSdkDriver(options)
  }
}
