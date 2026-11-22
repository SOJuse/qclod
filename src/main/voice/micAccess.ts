import type { Session, SystemPreferences, WebContents } from 'electron'

/**
 * Microphone permission of the window (stage 5, decision 14): the session
 * handler decides only `media`, and only audio for our own window. Every other
 * permission behaves as before (granted); narrowing them is not this stage's job.
 */
export function decideMedia(
  permission: string,
  details: { mediaTypes?: string[] },
  ours: boolean
): boolean {
  if (permission !== 'media') return true
  const types = details.mediaTypes ?? []
  return ours && types.length > 0 && types.every((t) => t === 'audio')
}

export function installMediaPermissions(
  ses: Session,
  isOurContents: (wc: WebContents | null) => boolean
): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(decideMedia(permission, details as { mediaTypes?: string[] }, isOurContents(wc)))
  })
  // Chromium also asks synchronously ("is it already allowed?"); the check
  // carries the type as a single `mediaType`.
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (permission !== 'media') return true
    const type = (details as { mediaType?: string }).mediaType
    return isOurContents(wc) && type === 'audio'
  })
}

export function micAccessStatus(
  sp?: Pick<SystemPreferences, 'getMediaAccessStatus'>,
  platform: string = process.platform
): 'granted' | 'denied' | 'unknown' {
  if (__QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_MIC_ACCESS'] === 'denied') return 'denied'
  if ((platform !== 'win32' && platform !== 'darwin') || !sp) return 'unknown'
  const status = sp.getMediaAccessStatus('microphone')
  if (status === 'granted') return 'granted'
  if (status === 'denied' || status === 'restricted') return 'denied'
  return 'unknown'
}

export async function askMicAccess(
  sp?: Partial<Pick<SystemPreferences, 'askForMediaAccess' | 'getMediaAccessStatus'>>,
  platform: string = process.platform
): Promise<boolean> {
  if (platform === 'darwin') return sp?.askForMediaAccess ? sp.askForMediaAccess('microphone') : false
  // Windows has no prompt of its own: the answer is the privacy switch.
  const status = micAccessStatus(
    sp?.getMediaAccessStatus ? { getMediaAccessStatus: sp.getMediaAccessStatus } : undefined,
    platform
  )
  return status !== 'denied'
}

export const MIC_SETTINGS_URL: Record<string, string> = {
  win32: 'ms-settings:privacy-microphone',
  darwin: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

/** A fixed string, so it does not go through isSafeExternalUrl. */
export async function openMicSettings(
  platform: string,
  openExternal: (url: string) => Promise<void>
): Promise<void> {
  const url = MIC_SETTINGS_URL[platform]
  if (url) await openExternal(url)
}
