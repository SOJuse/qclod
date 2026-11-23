// 1.0.1: vpn — the Windows per-user proxy (HKCU, no admin): set our PAC, give back the user's own.
import { execFile } from 'node:child_process'
import { PAC_PATH } from './pac'

export const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** The user's own values before ours; null — the value did not exist. */
export interface SavedProxy {
  autoConfigUrl: string | null
  proxyEnable: number | null
}

/** The registry, swapped in tests. */
export interface Registry {
  read(name: string): Promise<string | number | null>
  write(name: string, value: string | number): Promise<void>
  remove(name: string): Promise<void>
  /** Tells WinINet (and so browsers) the settings changed. */
  notify(): Promise<void>
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

const NOTIFY_PS =
  "$s='[DllImport(\"wininet.dll\")] public static extern bool InternetSetOption(System.IntPtr h,int o,System.IntPtr b,int l);';" +
  '$t=Add-Type -MemberDefinition $s -Name W -Namespace Q -PassThru;' +
  '[void]$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0);' +
  '[void]$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)'

export function windowsRegistry(): Registry {
  return {
    async read(name) {
      try {
        const out = await run('reg', ['query', INTERNET_SETTINGS, '/v', name])
        const m = new RegExp(`${name}\\s+(REG_\\w+)\\s+(.*)`).exec(out)
        if (!m) return null
        const v = m[2]!.trim()
        return m[1] === 'REG_DWORD' ? parseInt(v, 16) : v
      } catch {
        return null
      }
    },
    async write(name, value) {
      const type = typeof value === 'number' ? 'REG_DWORD' : 'REG_SZ'
      await run('reg', ['add', INTERNET_SETTINGS, '/v', name, '/t', type, '/d', String(value), '/f'])
    },
    async remove(name) {
      await run('reg', ['delete', INTERNET_SETTINGS, '/v', name, '/f']).catch(() => undefined)
    },
    async notify() {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', NOTIFY_PS]).catch(() => undefined)
    }
  }
}

export const isOurPac = (url: unknown): boolean => typeof url === 'string' && url.includes(PAC_PATH)

/**
 * Sets our PAC. Returns what was there before — unless what was there is a
 * leftover of ours (then the earlier saved value, given in `previous`, stands).
 */
export async function applyPac(reg: Registry, pacUrl: string, previous: SavedProxy | null): Promise<SavedProxy> {
  const url = await reg.read('AutoConfigURL')
  const enable = await reg.read('ProxyEnable')
  const saved: SavedProxy =
    isOurPac(url) && previous
      ? previous
      : {
          autoConfigUrl: isOurPac(url) ? null : typeof url === 'string' ? url : null,
          proxyEnable: typeof enable === 'number' ? enable : null
        }
  await reg.write('AutoConfigURL', pacUrl)
  await reg.notify()
  return saved
}

/** Gives back the user's own values; touches nothing if the PAC there now is not ours. */
export async function restorePac(reg: Registry, saved: SavedProxy | null): Promise<boolean> {
  const url = await reg.read('AutoConfigURL')
  if (!isOurPac(url)) return false
  if (saved?.autoConfigUrl) await reg.write('AutoConfigURL', saved.autoConfigUrl)
  else await reg.remove('AutoConfigURL')
  if (saved && saved.proxyEnable !== null) {
    const now = await reg.read('ProxyEnable')
    if (now !== saved.proxyEnable) await reg.write('ProxyEnable', saved.proxyEnable)
  }
  await reg.notify()
  return true
}
