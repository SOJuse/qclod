// Shared by the relay's tests: a fake-SDK driver factory, a temp folder and a wait.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeSdk, type FakeDriver, type FakeScript } from '../fixtures/fake-sdk/index.mjs'
import type { AgentDriver, DriverFactory, DriverOptions } from '../../src/main/agent/driver'
import { toPermissionContext } from '../../src/main/agent/permissionContext'
import type { RelaySessionRecord } from '../../src/relay/stateStore'

/** Every driver made, in order, with the options it was made with. */
export interface FakeFactory {
  factory: DriverFactory
  drivers: FakeDriver[]
  options: DriverOptions[]
}

export function fakeFactory(script: FakeScript | (() => FakeScript) = {}): FakeFactory {
  const drivers: FakeDriver[] = []
  const options: DriverOptions[] = []
  const factory: DriverFactory = (opts) => {
    const base = typeof script === 'function' ? script() : script
    const driver = createFakeSdk({
      ...base,
      canUseTool: (toolName, input, o) => opts.canUseTool(toolName, input, toPermissionContext(o)),
      init: { cwd: opts.cwd, ...(opts.model ? { model: opts.model } : {}), ...(base.init ?? {}) }
    })
    drivers.push(driver)
    options.push(opts)
    return driver as unknown as AgentDriver
  }
  return { factory, drivers, options }
}

export function record(s: string, extra: Partial<RelaySessionRecord> = {}): RelaySessionRecord {
  return {
    s,
    cwd: '/home/u/app',
    title: 'Чат',
    sdkSessionId: null,
    mode: 'default',
    remoteControl: false,
    wasRunning: false,
    createdAt: 1,
    ...extra
  }
}

const temps: string[] = []

export function tempDir(prefix = 'qclod-relay-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

export function cleanTemps(): void {
  for (const dir of temps.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A pipe or a file still held on Windows; the OS cleans its temp.
    }
  }
}

export async function until(check: () => boolean, ms = 5000, what = 'условие'): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`не дождались: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Timers that fire only when the test moves the time on, in order. */
export function manualClock(start = 1_000_000) {
  let now = start
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): unknown => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h: unknown): void => {
      timers.delete(h as number)
    },
    get pending(): number {
      return timers.size
    },
    advance(ms: number): void {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = Math.max(now, due[1].at)
        due[1].fn()
      }
      now = end
    }
  }
}
