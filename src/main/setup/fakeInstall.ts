import { writeFileSync } from 'node:fs'
import type { InstallHandle, InstallMethod } from './install'

export interface FakeInstallConfig {
  methods: InstallMethod[]
  results: boolean[]
  createAgentAt?: string
}

/**
 * The e2e stand-in for the installer: spawns nothing. Step i ends after 50 ms
 * with results[i]; a successful step creates the empty agent file, so the
 * next environment check finds an "installed" agent. Only ever built behind
 * the test-seam gate in ipc.ts.
 */
export function fakeInstaller(config: FakeInstallConfig): {
  detectMethods: () => Promise<InstallMethod[]>
  detect: () => Promise<InstallMethod | null>
  start: (
    method: InstallMethod,
    onOutput: (line: string) => void,
    onDone: (ok: boolean) => void
  ) => InstallHandle
} {
  let step = 0
  return {
    detectMethods: async () => config.methods,
    detect: async () => config.methods[0] ?? null,
    start: (method, onOutput, onDone) => {
      const ok = config.results[step++] ?? false
      onOutput(`фейковая установка: ${method}`)
      const timer = setTimeout(() => {
        if (ok && config.createAgentAt) writeFileSync(config.createAgentAt, '')
        onDone(ok)
      }, 50)
      return {
        cancel: () => {
          clearTimeout(timer)
          onOutput('Отменено.')
          onDone(false)
        }
      }
    }
  }
}
