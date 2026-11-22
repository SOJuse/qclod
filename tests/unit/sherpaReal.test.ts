/**
 * Real models, real sherpa-onnx-node. Skipped unless
 *   QCLOD_VOICE_TEST_MODELS=C:\dev\qclod-voice-proto\models
 *   QCLOD_VOICE_TEST_AUDIO=C:\dev\qclod-voice-proto\audio
 * are set. 0.3 + 0.9 GB of memory: never alongside another lane's e2e.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { LiveDecoder } from '@main/voice/liveDecoder'
import type { PhraseEvent } from '@main/voice/engine'
import { isAsciiPath, modelsRoot } from '@main/voice/modelsRoot'
import { loadSherpa, SherpaEngine, type SherpaPaths } from '@main/voice/sherpaEngine'
import { SileroVad } from '@main/voice/sileroVad'

const MODELS = process.env['QCLOD_VOICE_TEST_MODELS']
const AUDIO = process.env['QCLOD_VOICE_TEST_AUDIO']
const run = MODELS !== undefined && AUDIO !== undefined
const SLOW = 180_000

const GIGA_DIR = 'sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16'
const PARA_DIR = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
const GIGA_FILES = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'] as const

function giga(dir: string): SherpaPaths {
  return {
    model: 'gigaam-v3',
    encoder: join(dir, 'encoder.int8.onnx'),
    decoder: join(dir, 'decoder.onnx'),
    joiner: join(dir, 'joiner.onnx'),
    tokens: join(dir, 'tokens.txt')
  }
}

function parakeet(dir: string): SherpaPaths {
  return {
    model: 'parakeet-v3',
    encoder: join(dir, 'encoder.int8.onnx'),
    decoder: join(dir, 'decoder.int8.onnx'),
    joiner: join(dir, 'joiner.int8.onnx'),
    tokens: join(dir, 'tokens.txt')
  }
}

function wav(rel: string): Float32Array {
  const mod = loadSherpa() as unknown as {
    readWave(p: string, ext: boolean): { samples: Float32Array; sampleRate: number }
  }
  const w = mod.readWave(join(AUDIO!, rel), false)
  expect(w.sampleRate).toBe(16000)
  return w.samples
}

const temps: string[] = []
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true })
})

describe.skipIf(!run)('sherpa на настоящих моделях', () => {
  test(
    'GigaAM: g00.wav даёт текст с «тенге» и «?» в конце',
    async () => {
      const e = new SherpaEngine(giga(join(MODELS!, GIGA_DIR)), 4)
      await e.load()
      const text = await e.decode(wav('golos/g00.wav'))
      await e.dispose()
      console.log('[sherpaReal] GigaAM g00:', text)
      expect(text).toContain('тенге')
      expect(text.endsWith('?')).toBe(true)
    },
    SLOW
  )

  test(
    'Parakeet: тот же файл, текст с «тенге»',
    async () => {
      const e = new SherpaEngine(parakeet(join(MODELS!, PARA_DIR)), 4)
      await e.load()
      const text = await e.decode(wav('golos/g00.wav'))
      await e.dispose()
      console.log('[sherpaReal] Parakeet g00:', text)
      expect(text).toContain('тенге')
    },
    SLOW
  )

  test(
    'LiveDecoder на настоящей GigaAM и Silero: mm_t00.wav → один final с «тайп-скрипт»',
    async () => {
      const engine = new SherpaEngine(giga(join(MODELS!, GIGA_DIR)), 4)
      await engine.load()
      const vad = new SileroVad(join(MODELS!, 'silero_vad.onnx'))
      const events: PhraseEvent[] = []
      const errors: unknown[] = []
      const d = new LiveDecoder({ engine, vad, emit: (e) => events.push(e), onError: (e) => errors.push(e) })
      const sound = wav('tts/mm_t00.wav')
      const all = new Float32Array(sound.length + 16000)
      all.set(sound)
      for (let at = 0; at < all.length; at += 1600) {
        d.push(all.subarray(at, Math.min(all.length, at + 1600)))
        await new Promise((r) => setImmediate(r))
      }
      await d.finish()
      await engine.dispose()
      const finals = events.filter((e) => e.kind === 'final')
      console.log('[sherpaReal] LiveDecoder mm_t00:', JSON.stringify(events))
      expect(errors).toEqual([])
      expect(finals).toHaveLength(1)
      expect(finals[0].text).toContain('тайп-скрипт')
    },
    SLOW
  )

  test(
    'модель из папки с кириллицей («голос тест» в tmp)',
    async () => {
      const base = mkdtempSync(join(tmpdir(), 'qclod-voice-'))
      temps.push(base)
      const userData = join(base, 'голос тест')
      const direct = join(userData, 'models', 'gigaam')
      mkdirSync(direct, { recursive: true })
      for (const f of GIGA_FILES) copyFileSync(join(MODELS!, GIGA_DIR, f), join(direct, f))
      const sound = wav('golos/g00.wav')

      let directResult: string
      try {
        const e = new SherpaEngine(giga(direct), 2)
        await e.load()
        directResult = 'грузится: ' + (await e.decode(sound))
        await e.dispose()
      } catch (err) {
        directResult = 'не грузится: ' + (err instanceof Error ? err.message : String(err))
      }
      console.log('[sherpaReal] из кириллицы напрямую —', directResult)

      const root = modelsRoot(userData)
      console.log('[sherpaReal] modelsRoot:', root)
      expect(isAsciiPath(root)).toBe(true)
      const safe = join(root, 'gigaam')
      if (!existsSync(join(safe, 'tokens.txt'))) {
        // No 8.3 names on this volume: the fallback folder is a different place.
        mkdirSync(safe, { recursive: true })
        temps.push(safe)
        for (const f of GIGA_FILES) copyFileSync(join(MODELS!, GIGA_DIR, f), join(safe, f))
      }
      const e = new SherpaEngine(giga(safe), 2)
      await e.load()
      const text = await e.decode(sound)
      await e.dispose()
      expect(text).toContain('тенге')
    },
    SLOW
  )
})
