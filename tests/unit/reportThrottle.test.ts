import { describe, expect, test } from 'vitest'
import { ReportThrottle } from '../../src/main/system/reportThrottle'

function make(): { gate: ReportThrottle; advance: (ms: number) => void } {
  let t = 0
  return { gate: new ReportThrottle({ now: () => t }), advance: (ms) => void (t += ms) }
}

describe('ReportThrottle', () => {
  test('lets 20 distinct reports in 10 s through and holds back the 21st', () => {
    const { gate } = make()
    for (let i = 0; i < 20; i++) expect(gate.check(1, `e${i}`).admit).toBe(true)
    expect(gate.check(1, 'e20').admit).toBe(false)
  })

  test('once the window reopens the next report carries the dropped count', () => {
    const { gate, advance } = make()
    for (let i = 0; i < 20; i++) gate.check(1, `e${i}`)
    gate.check(1, 'x')
    gate.check(1, 'y')
    advance(10_000)
    expect(gate.check(1, 'z')).toEqual({ admit: true, dropped: 2 })
    expect(gate.check(1, 'w')).toEqual({ admit: true, dropped: 0 })
  })

  test('an identical report within 10 s is collapsed into the counter', () => {
    const { gate, advance } = make()
    expect(gate.check(1, 'same').admit).toBe(true)
    expect(gate.check(1, 'same').admit).toBe(false)
    advance(9_999)
    expect(gate.check(1, 'same').admit).toBe(false)
    advance(1)
    expect(gate.check(1, 'same')).toEqual({ admit: true, dropped: 2 })
  })

  test('senders are counted separately', () => {
    const { gate } = make()
    for (let i = 0; i < 20; i++) gate.check(1, `e${i}`)
    expect(gate.check(1, 'more').admit).toBe(false)
    expect(gate.check(2, 'more').admit).toBe(true)
  })
})
