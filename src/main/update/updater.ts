import type { UpdateState } from '../../shared/types'

/** The first look waits until the window is up and the tabs are back. */
export const UPDATE_FIRST_CHECK_MS = 10000
/** The app may stay in the tray for weeks; it looks again every six hours. */
export const UPDATE_RECHECK_MS = 6 * 60 * 60 * 1000

/**
 * Where updates come from: `autoUpdater` of electron-updater in an installed
 * app, a fake in the e2e build. Only what UpdateFlow needs.
 */
export interface UpdateSource {
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
  onDownloaded(cb: (version: string) => void): void
  onError(cb: (err: Error) => void): void
  /** How long the first check waits, when not UPDATE_FIRST_CHECK_MS (the fake looks at once). */
  readonly firstCheckMs?: number
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Checks for a new version now and then, and says when one is downloaded.
 *
 * A failed check — no network, or "certificate is not yet valid" from a
 * clock that runs behind — is one line in the log and nothing else: the
 * state stays idle, the person sees nothing, and the next check is on the
 * schedule as usual. Certificates are never relaxed to make a check pass.
 */
export class UpdateFlow {
  private current: UpdateState = { kind: 'idle' }
  private readonly setTimer: (fn: () => void, ms: number) => unknown

  constructor(
    private readonly deps: {
      source: UpdateSource
      onState: (s: UpdateState) => void
      log: (msg: string) => void
      setTimer?: (fn: () => void, ms: number) => unknown
    }
  ) {
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms)
        // A pending check must not keep the process alive on quit.
        timer.unref()
        return timer
      })
    deps.source.onDownloaded((version) => {
      if (this.current.kind === 'ready') return
      this.current = { kind: 'ready', version }
      deps.onState(this.current)
    })
    deps.source.onError((err) => deps.log(`ошибка обновления: ${messageOf(err)}`))
  }

  get state(): UpdateState {
    return this.current
  }

  start(delayMs: number = UPDATE_FIRST_CHECK_MS): void {
    this.setTimer(() => this.check(), delayMs)
  }

  /** Quits and installs the downloaded version; false when there is none yet. */
  restart(): boolean {
    if (this.current.kind !== 'ready') return false
    this.deps.source.quitAndInstall(true, true)
    return true
  }

  private check(): void {
    // A downloaded version installs on the next quit; nothing more to look for.
    if (this.current.kind === 'ready') return
    let pending: Promise<unknown>
    try {
      pending = Promise.resolve(this.deps.source.checkForUpdates())
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending.catch((err: unknown) => this.deps.log(`проверка обновления не удалась: ${messageOf(err)}`))
    this.setTimer(() => this.check(), UPDATE_RECHECK_MS)
  }
}

/**
 * The updater for this run, or null when there is none to have: a build run
 * from the source tree has no release to compare itself with.
 *
 * In the e2e build `QCLOD_FAKE_UPDATE` (JSON `{ version?, error? }`) stands in
 * for GitHub: a version is "downloaded" at the first check, an error fails it,
 * and a restart only counts itself in `globalThis.__qclodUpdateRestarts`. The
 * release build has no such branch (buildFlags.d.ts).
 */
export function createUpdateSource(isPackaged: boolean): UpdateSource | null {
  // A Mac build is unsigned and has no auto-update: it only tells (macNotifier.ts).
  if (process.platform === 'darwin') return null
  const fakeSpec = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_UPDATE'] : undefined
  if (__QCLOD_TEST_SEAMS__ && fakeSpec !== undefined) {
    let spec: { version?: string; error?: string }
    try {
      spec = JSON.parse(fakeSpec) as { version?: string; error?: string }
    } catch (err) {
      console.warn('[update] QCLOD_FAKE_UPDATE is not valid JSON, updates are off:', messageOf(err))
      return null
    }
    const downloaded: Array<(version: string) => void> = []
    const errored: Array<(err: Error) => void> = []
    const counter = globalThis as { __qclodUpdateRestarts?: number }
    counter.__qclodUpdateRestarts = 0
    return {
      firstCheckMs: 0,
      checkForUpdates: async () => {
        if (spec.error) {
          const err = new Error(spec.error)
          for (const cb of errored) cb(err)
          throw err
        }
        if (spec.version) for (const cb of downloaded) cb(spec.version)
        return null
      },
      quitAndInstall: () => {
        counter.__qclodUpdateRestarts = (counter.__qclodUpdateRestarts ?? 0) + 1
      },
      onDownloaded: (cb) => void downloaded.push(cb),
      onError: (cb) => void errored.push(cb)
    }
  }

  // The portable Qclod.exe does not update itself: the updater would install
  // the NSIS copy on quit, next to the portable one. electron-builder's
  // portable launcher sets this variable.
  if (process.env['PORTABLE_EXECUTABLE_DIR']) return null
  // A test build, packaged or not, never asks GitHub: no test touches the network.
  if (__QCLOD_TEST_SEAMS__) return null
  if (!isPackaged) return null

  // Loaded only here: a run from the source tree never touches it.
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  return {
    checkForUpdates: async () => {
      const result = await autoUpdater.checkForUpdates()
      // The download runs on after the check returns, and its failure is
      // also sent as an `error` event, which is logged; left uncaught here
      // it would be an unhandled rejection.
      result?.downloadPromise?.catch(() => undefined)
      return result
    },
    quitAndInstall: (isSilent, isForceRunAfter) =>
      autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
    onDownloaded: (cb) => {
      autoUpdater.on('update-downloaded', (info) => cb(info.version))
    },
    onError: (cb) => {
      autoUpdater.on('error', (err) => cb(err))
    }
  }
}
