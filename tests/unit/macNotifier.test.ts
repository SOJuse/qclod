import { describe, expect, test, vi } from 'vitest'
import {
  MacUpdateNotifier,
  RELEASES_LATEST,
  isNewer,
  parseFakeAvailable,
  parseLatestRelease
} from '../../src/main/update/macNotifier'
import { UPDATE_FIRST_CHECK_MS, UPDATE_RECHECK_MS } from '../../src/main/update/updater'
import type { UpdateState } from '../../src/shared/types'

const release = (v: string) => ({ tag_name: `v${v}`, html_url: `https://github.com/SOJuse/qclod/releases/tag/v${v}` })

describe('isNewer', () => {
  test('сравнивает x.y.z по числам', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true)
    expect(isNewer('1.10.0', '1.9.0')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('0.9.9', '1.0.0')).toBe(false)
  })
  test('пререлиз и не-semver — не новее', () => {
    expect(isNewer('1.1.0-beta.1', '1.0.0')).toBe(false)
    expect(isNewer('latest', '1.0.0')).toBe(false)
  })
})

describe('parseLatestRelease', () => {
  test('новая версия со ссылкой на релиз', () => {
    expect(parseLatestRelease(release('1.1.0'), '1.0.0')).toEqual({
      version: '1.1.0',
      url: 'https://github.com/SOJuse/qclod/releases/tag/v1.1.0'
    })
  })
  test('та же или старая версия — null', () => {
    expect(parseLatestRelease(release('1.0.0'), '1.0.0')).toBeNull()
    expect(parseLatestRelease(release('0.9.0'), '1.0.0')).toBeNull()
  })
  test('чужая ссылка — null', () => {
    for (const html_url of [
      'https://evil.example/SOJuse/qclod/releases/tag/v1.1.0',
      'https://github.com/other/qclod/releases/tag/v1.1.0',
      'http://github.com/SOJuse/qclod/releases/tag/v1.1.0',
      'https://github.com/SOJuse/qclod/releases/tag/v1.1.0?x=1',
      'javascript:alert(1)'
    ]) {
      expect(parseLatestRelease({ tag_name: 'v1.1.0', html_url }, '1.0.0')).toBeNull()
    }
  })
  test('tag_name не semver или нет полей — null', () => {
    expect(parseLatestRelease({ tag_name: 'nightly', html_url: release('1.1.0').html_url }, '1.0.0')).toBeNull()
    expect(parseLatestRelease({ tag_name: 'v1.1', html_url: release('1.1.0').html_url }, '1.0.0')).toBeNull()
    expect(parseLatestRelease({}, '1.0.0')).toBeNull()
    expect(parseLatestRelease(null, '1.0.0')).toBeNull()
    expect(parseLatestRelease('x', '1.0.0')).toBeNull()
  })
})

function setup(fetchJson: (url: string) => Promise<unknown>) {
  const timers: Array<{ fn: () => void; ms: number }> = []
  const states: UpdateState[] = []
  const log = vi.fn()
  const notifier = new MacUpdateNotifier({
    fetchJson: vi.fn(fetchJson),
    currentVersion: '1.0.0',
    onState: (s) => states.push(s),
    log,
    setTimer: (fn, ms) => void timers.push({ fn, ms })
  })
  return { notifier, timers, states, log }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('MacUpdateNotifier', () => {
  test('первая проверка через UPDATE_FIRST_CHECK_MS, дальше раз в UPDATE_RECHECK_MS', async () => {
    const { notifier, timers } = setup(async () => release('1.0.0'))
    notifier.start()
    expect(timers.map((t) => t.ms)).toEqual([UPDATE_FIRST_CHECK_MS])
    timers[0]!.fn()
    await flush()
    expect(timers.map((t) => t.ms)).toEqual([UPDATE_FIRST_CHECK_MS, UPDATE_RECHECK_MS])
  })

  test('спрашивает latest и сообщает «available» один раз', async () => {
    const { notifier, timers, states } = setup(async () => release('1.1.0'))
    notifier.start(0)
    timers[0]!.fn()
    await flush()
    timers[1]!.fn()
    await flush()
    expect(states).toEqual([
      { kind: 'available', version: '1.1.0', url: 'https://github.com/SOJuse/qclod/releases/tag/v1.1.0' }
    ])
    expect(notifier.state.kind).toBe('available')
    expect(RELEASES_LATEST).toBe('https://api.github.com/repos/SOJuse/qclod/releases/latest')
  })

  test('ошибка сети — одна строка лога, состояние idle', async () => {
    const { notifier, timers, states, log } = setup(async () => {
      throw new Error('offline')
    })
    notifier.start(0)
    timers[0]!.fn()
    await flush()
    expect(log).toHaveBeenCalledTimes(1)
    expect(states).toEqual([])
    expect(notifier.state).toEqual({ kind: 'idle' })
  })
})

describe('parseFakeAvailable', () => {
  test('только строка x.y.z', () => {
    expect(parseFakeAvailable('{"available":"9.9.9"}')).toBe('9.9.9')
    expect(parseFakeAvailable('{"available":"x"}')).toBeNull()
    expect(parseFakeAvailable('{"version":"9.9.9"}')).toBeNull()
    expect(parseFakeAvailable('не json')).toBeNull()
    expect(parseFakeAvailable(undefined)).toBeNull()
  })
})
