import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  askMicAccess,
  decideMedia,
  installMediaPermissions,
  micAccessStatus,
  MIC_SETTINGS_URL,
  openMicSettings
} from '../../src/main/voice/micAccess'

describe('decideMedia', () => {
  test('audio only, our window only', () => {
    expect(decideMedia('media', { mediaTypes: ['audio'] }, true)).toBe(true)
    expect(decideMedia('media', { mediaTypes: ['video'] }, true)).toBe(false)
    expect(decideMedia('media', { mediaTypes: ['audio', 'video'] }, true)).toBe(false)
    expect(decideMedia('media', { mediaTypes: [] }, true)).toBe(false)
    expect(decideMedia('media', {}, true)).toBe(false)
    expect(decideMedia('media', { mediaTypes: ['audio'] }, false)).toBe(false)
  })
  test('other permissions are left as they were', () => {
    expect(decideMedia('notifications', {}, false)).toBe(true)
  })
})

describe('installMediaPermissions', () => {
  test('request and check handlers apply the same rule', () => {
    let request!: (...a: unknown[]) => void
    let check!: (...a: unknown[]) => boolean
    const ses = {
      setPermissionRequestHandler: (h: typeof request) => (request = h),
      setPermissionCheckHandler: (h: typeof check) => (check = h)
    }
    const ours = {}
    installMediaPermissions(ses as never, (wc) => wc === (ours as never))
    const cb = vi.fn()
    request(ours, 'media', cb, { mediaTypes: ['audio'] })
    request({}, 'media', cb, { mediaTypes: ['audio'] })
    request(ours, 'media', cb, { mediaTypes: ['video'] })
    expect(cb.mock.calls.map((c) => c[0])).toEqual([true, false, false])
    expect(check(ours, 'media', 'file://', { mediaType: 'audio' })).toBe(true)
    expect(check(ours, 'media', 'file://', { mediaType: 'video' })).toBe(false)
    expect(check({}, 'media', 'file://', { mediaType: 'audio' })).toBe(false)
    expect(check({}, 'clipboard-read', 'file://', {})).toBe(true)
  })
})

describe('micAccessStatus / askMicAccess', () => {
  afterEach(() => vi.unstubAllEnvs())
  const sp = (s: string) => ({ getMediaAccessStatus: () => s }) as never
  test('statuses', () => {
    expect(micAccessStatus(sp('denied'), 'win32')).toBe('denied')
    expect(micAccessStatus(sp('granted'), 'darwin')).toBe('granted')
    expect(micAccessStatus(sp('denied'), 'linux')).toBe('unknown')
  })
  test('the fake-denied seam', () => {
    vi.stubEnv('QCLOD_FAKE_MIC_ACCESS', 'denied')
    expect(micAccessStatus(undefined, 'linux')).toBe('denied')
  })
  test('darwin asks the system, win32 reads the switch', async () => {
    const askForMediaAccess = vi.fn().mockResolvedValue(true)
    expect(await askMicAccess({ askForMediaAccess } as never, 'darwin')).toBe(true)
    expect(askForMediaAccess).toHaveBeenCalledWith('microphone')
    expect(await askMicAccess({ getMediaAccessStatus: () => 'denied' } as never, 'win32')).toBe(false)
    expect(await askMicAccess({ getMediaAccessStatus: () => 'granted' } as never, 'win32')).toBe(true)
  })
})

describe('openMicSettings', () => {
  test('opens the fixed address, nothing for unknown platforms', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    await openMicSettings('win32', open)
    expect(open).toHaveBeenCalledWith(MIC_SETTINGS_URL['win32'])
    expect(MIC_SETTINGS_URL['win32']).toBe('ms-settings:privacy-microphone')
    await openMicSettings('linux', open)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
