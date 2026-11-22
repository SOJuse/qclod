import { describe, expect, test } from 'vitest'
import { EnergyVad } from '@main/voice/energyVad'

const RATE = 16_000

function tone(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE)
  return out
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * RATE))
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function feed(vad: EnergyVad, pcm: Float32Array, chunk: number): void {
  for (let i = 0; i < pcm.length; i += chunk) vad.accept(pcm.subarray(i, i + chunk))
}

describe('EnergyVad', () => {
  test('тон 1 с, затем тишина 1 с: speaking включается, takeClosed даёт 1 ровно один раз', () => {
    const vad = new EnergyVad()
    expect(vad.speaking).toBe(false)
    feed(vad, tone(1), 1600)
    expect(vad.speaking).toBe(true)
    expect(vad.takeClosed()).toBe(0)
    feed(vad, silence(1), 1600)
    expect(vad.speaking).toBe(false)
    expect(vad.takeClosed()).toBe(1)
    expect(vad.takeClosed()).toBe(0)
  })

  test('тишина 0,5 с внутри речи фразу не закрывает', () => {
    const vad = new EnergyVad()
    feed(vad, concat(tone(1), silence(0.5), tone(1)), 1600)
    expect(vad.speaking).toBe(true)
    expect(vad.takeClosed()).toBe(0)
  })

  test('короткий звук меньше 0,25 с речью не считается', () => {
    const vad = new EnergyVad()
    feed(vad, concat(tone(0.15), silence(1)), 1600)
    expect(vad.speaking).toBe(false)
    expect(vad.takeClosed()).toBe(0)
  })

  test('куски по 100 и 1600 сэмплов дают одинаковый результат', () => {
    const pcm = concat(silence(0.3), tone(1), silence(0.5), tone(0.5), silence(1))
    const run = (chunk: number): number[] => {
      const vad = new EnergyVad()
      const trace: number[] = []
      for (let i = 0; i < pcm.length; i += chunk) {
        vad.accept(pcm.subarray(i, i + chunk))
        trace.push(vad.speaking ? 1 : 0)
      }
      trace.push(vad.takeClosed())
      return [vad.speaking ? 1 : 0, vad.takeClosed(), trace[trace.length - 1]]
    }
    expect(run(100)).toEqual(run(1600))
    expect(run(100)).toEqual([0, 0, 1])
  })

  test('flush закрывает идущую фразу, reset всё забывает', () => {
    const vad = new EnergyVad()
    feed(vad, tone(1), 1600)
    vad.flush()
    expect(vad.speaking).toBe(false)
    expect(vad.takeClosed()).toBe(1)
    feed(vad, tone(1), 1600)
    vad.reset()
    expect(vad.speaking).toBe(false)
    expect(vad.takeClosed()).toBe(0)
  })

  test('вторая фраза после паузы считается отдельно', () => {
    const vad = new EnergyVad()
    feed(vad, concat(tone(1), silence(1), tone(1), silence(1)), 800)
    expect(vad.takeClosed()).toBe(2)
  })
})
