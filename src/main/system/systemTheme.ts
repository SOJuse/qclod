import { execFile } from 'node:child_process'

const PERSONALIZE_KEY = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'

/** `reg query ... /v SystemUsesLightTheme` output → true (light taskbar), false (dark), null (unreadable). */
export function parseSystemUsesLightTheme(stdout: string): boolean | null {
  const match = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)
  if (!match) return null
  const value = parseInt(match[1]!, 16)
  return value === 1 ? true : value === 0 ? false : null
}

/**
 * Whether the Windows taskbar is light. `nativeTheme.shouldUseDarkColors`
 * follows the apps' theme, not the taskbar's, so the registry is asked.
 * Anything but Windows, or any failure → null.
 */
export function readTaskbarLight(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', PERSONALIZE_KEY, '/v', 'SystemUsesLightTheme'],
      { windowsHide: true, timeout: 3000 },
      (error, stdout) => resolve(error ? null : parseSystemUsesLightTheme(stdout))
    )
  })
}
