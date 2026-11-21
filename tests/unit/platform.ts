/**
 * Runs `fn` as if the process were on `platform`. For code that reads
 * `process.platform` directly and has no parameter for it; the real value is
 * put back afterwards, also when `fn` throws or its promise rejects.
 */
export function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value: platform })
  const restore = (): void => {
    Object.defineProperty(process, 'platform', original)
  }
  let result: T
  try {
    result = fn()
  } catch (e) {
    restore()
    throw e
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T
  }
  restore()
  return result
}

/** Pins `process.platform` for a whole describe: call inside it, restores in afterEach. */
export function pinPlatform(
  platform: NodeJS.Platform,
  hooks: { beforeEach: (fn: () => void) => void; afterEach: (fn: () => void) => void }
): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  hooks.beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...original, value: platform })
  })
  hooks.afterEach(() => {
    Object.defineProperty(process, 'platform', original)
  })
}
