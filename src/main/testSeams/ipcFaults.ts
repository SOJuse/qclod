/**
 * Test seam: a slow or failing IPC handler, so e2e can see the loading and
 * error states of the screens that wait on it. In the e2e build only:
 *
 * - `QCLOD_FAKE_SLOW` — JSON `{ [channel]: ms }`: the handler waits that long first.
 * - `QCLOD_FAKE_FAIL` — JSON `{ [channel]: message }`: the handler throws `new Error(message)`.
 * - `QCLOD_FAKE_FAIL_TIMES` — JSON `{ [channel]: n }`: fail only the first n calls
 *   (without it, every call fails), so «Повторить» can be seen to work.
 *
 * A release build reads none of them and just runs the handler.
 */

/** Calls made per channel while a failure was asked for, for QCLOD_FAKE_FAIL_TIMES. */
const failedCalls = new Map<string, number>()

function entry(name: string, channel: string): unknown {
  const raw = process.env[name]
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed && typeof parsed === 'object' ? parsed[channel] : undefined
  } catch {
    console.warn(`[seam] ${name} is not valid JSON, ignored`)
    return undefined
  }
}

export async function withFault<T>(channel: string, run: () => T | Promise<T>): Promise<T> {
  if (__QCLOD_TEST_SEAMS__) {
    const delay = Number(entry('QCLOD_FAKE_SLOW', channel) ?? 0)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

    const message = entry('QCLOD_FAKE_FAIL', channel)
    if (typeof message === 'string') {
      const times = entry('QCLOD_FAKE_FAIL_TIMES', channel)
      const made = failedCalls.get(channel) ?? 0
      failedCalls.set(channel, made + 1)
      if (typeof times !== 'number' || made < times) throw new Error(message)
    }
  }
  return run()
}
