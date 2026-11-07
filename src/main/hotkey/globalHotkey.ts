import type { HotkeyRegistration } from '../../shared/types'

/** The slice of Electron's globalShortcut this needs, so it can be tested. */
export interface ShortcutApi {
  register: (accelerator: string, callback: () => void) => boolean
  unregister: (accelerator: string) => void
  isRegistered: (accelerator: string) => boolean
}

/**
 * Owns the single system-wide shortcut that summons the window.
 *
 * Registration can simply fail — another application may already hold the
 * combination — and Electron reports that by returning false rather than
 * throwing. Swallowing it would leave the user pressing a key that does
 * nothing with no way to find out why, so the outcome is kept and surfaced.
 */
export class HotkeyRegistrar {
  private current: string | null = null
  private last: HotkeyRegistration = { ok: true, accelerator: '' }

  constructor(
    private readonly api: ShortcutApi,
    private readonly onTrigger: () => void
  ) {}

  get status(): HotkeyRegistration {
    return this.last
  }

  apply(accelerator: string): HotkeyRegistration {
    this.release()

    const wanted = accelerator.trim()
    if (wanted === '') {
      this.last = { ok: true, accelerator: '' }
      return this.last
    }

    let ok = false
    try {
      ok = this.api.register(wanted, this.onTrigger)
    } catch {
      ok = false
    }

    this.current = ok ? wanted : null
    this.last = ok
      ? { ok: true, accelerator: wanted }
      : {
          ok: false,
          accelerator: wanted,
          reason: `Комбинацию ${wanted} занимает другое приложение — выберите другую в настройках.`
        }
    return this.last
  }

  release(): void {
    if (this.current === null) return
    try {
      this.api.unregister(this.current)
    } catch {
      /* already gone */
    }
    this.current = null
  }
}
