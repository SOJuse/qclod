import { describe, expect, test } from 'vitest'
import { CHANNELS, INVOKE_CHANNELS, EVENT_CHANNELS } from '@shared/channels'

describe('ipc channel contract', () => {
  test('все имена каналов уникальны', () => {
    const names = Object.values(CHANNELS)
    expect(new Set(names).size).toBe(names.length)
  })

  test('CHANNELS заморожен', () => {
    expect(Object.isFrozen(CHANNELS)).toBe(true)
  })

  test('каждый канал отнесён либо к invoke, либо к event', () => {
    const classified = new Set<string>([...INVOKE_CHANNELS, ...EVENT_CHANNELS])
    for (const name of Object.values(CHANNELS)) {
      expect(classified.has(name)).toBe(true)
    }
    expect(classified.size).toBe(Object.values(CHANNELS).length)
  })

  test('invoke и event каналы не пересекаются', () => {
    const events = new Set<string>(EVENT_CHANNELS)
    for (const name of INVOKE_CHANNELS) expect(events.has(name)).toBe(false)
  })
})
