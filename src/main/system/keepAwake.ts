import type { AutonomyView, SessionStatus } from '../../shared/types'

export interface KeepAwakeBackend {
  start(): void
  stop(): void
}

/** The request is let go this long after the need has passed, so it does not blink between turns. */
export const RELEASE_GRACE_MS = 120_000

/** From the probe (task 3, 07-keep-awake-probe.md): Electron's request is not in SYSTEM. */
export const USE_EXECUTION_STATE_HELPER = true

/** ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED */
export const EXECUTION_STATE_FLAGS = 0x80000041

/** The helper sets the state, then leaves by itself soon after Qclod is gone. */
export function WIN_HELPER_SCRIPT(parentPid: number): string {
  return [
    `$k = Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace Q -PassThru`,
    `[void]$k::SetThreadExecutionState(0x${EXECUTION_STATE_FLAGS.toString(16)})`,
    `while (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`
  ].join('\n')
}

export function electronBlocker(
  psb: Pick<Electron.PowerSaveBlocker, 'start' | 'stop' | 'isStarted'>
): KeepAwakeBackend {
  let id: number | null = null
  return {
    start() {
      if (id !== null && psb.isStarted(id)) return
      id = psb.start('prevent-app-suspension')
    },
    stop() {
      if (id !== null && psb.isStarted(id)) psb.stop(id)
      id = null
    }
  }
}

type SpawnFn = typeof import('node:child_process').spawn

export function executionStateHelper(spawn: SpawnFn, parentPid: number): KeepAwakeBackend {
  let child: ReturnType<SpawnFn> | null = null
  return {
    start() {
      if (child) return
      const started = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-Command',
          WIN_HELPER_SCRIPT(parentPid)
        ],
        { windowsHide: true, stdio: 'ignore' }
      )
      // No powershell is not a reason to fail: powerSaveBlocker still holds.
      started.on('error', () => {
        if (child === started) child = null
      })
      started.on('exit', () => {
        if (child === started) child = null
      })
      child = started
    },
    stop() {
      const c = child
      child = null
      c?.kill()
    }
  }
}

type Timers = { set: typeof setTimeout; clear: typeof clearTimeout }

export class KeepAwake {
  private on = false
  private release: ReturnType<typeof setTimeout> | null = null
  private listeners: Array<(active: boolean) => void> = []

  constructor(
    private readonly backends: KeepAwakeBackend[],
    private readonly timers: Timers = { set: setTimeout, clear: clearTimeout }
  ) {}

  get active(): boolean {
    return this.on
  }

  onChange(cb: (active: boolean) => void): void {
    this.listeners.push(cb)
  }

  set(needed: boolean): void {
    if (needed) {
      this.cancelRelease()
      if (this.on) return
      this.on = true
      for (const b of this.backends) this.safely(() => b.start())
      this.emit()
      return
    }
    if (!this.on || this.release) return
    this.release = this.timers.set(() => {
      this.release = null
      this.stopAll()
    }, RELEASE_GRACE_MS)
    ;(this.release as { unref?: () => void }).unref?.()
  }

  dispose(): void {
    this.cancelRelease()
    this.stopAll()
  }

  private stopAll(): void {
    if (!this.on) return
    this.on = false
    for (const b of this.backends) this.safely(() => b.stop())
    this.emit()
  }

  private cancelRelease(): void {
    if (this.release) this.timers.clear(this.release)
    this.release = null
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.on)
  }

  private safely(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      console.warn('[keep-awake]', err instanceof Error ? err.message : String(err))
    }
  }
}

/** Awake while an agent works or waits for the person, or a limit reset is being waited out. */
export function awakeNeeded(statuses: SessionStatus[], views: AutonomyView[]): boolean {
  return statuses.some((s) => s === 'busy' || s === 'waiting') || views.some((v) => v.limitWait !== null)
}
