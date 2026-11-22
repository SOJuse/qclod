import { describe, expect, test } from 'vitest'
import { VOICE_MODEL_IDS, VOICE_MODEL_INFO, voiceErrorText, type VoiceErrorCode } from '@shared/voice'

const CODES: VoiceErrorCode[] = [
  'no-model',
  'mic-denied',
  'mic-missing',
  'mic-busy',
  'mic-lost',
  'engine-crashed',
  'engine-gave-up',
  'ort-conflict',
  'engine-missing',
  'load-failed',
  'gpu-fallback',
  'gpu-failed'
]

describe('контракт голоса', () => {
  test('у каждой модели есть описание, у Whisper — NVIDIA и только win32', () => {
    for (const id of VOICE_MODEL_IDS) {
      const info = VOICE_MODEL_INFO[id]
      expect(info.title.length, id).toBeGreaterThan(0)
      expect(info.blurb.length, id).toBeGreaterThan(0)
      expect(info.meta.length, id).toBeGreaterThan(0)
      expect(info.downloadBytes, id).toBeGreaterThan(0)
    }
    expect(VOICE_MODEL_INFO['whisper-turbo-cuda'].needsNvidia).toBe(true)
    expect(VOICE_MODEL_INFO['whisper-turbo-cuda'].platforms).toEqual(['win32'])
    expect(VOICE_MODEL_INFO['gigaam-v3'].needsNvidia).toBe(false)
    expect(VOICE_MODEL_INFO['gigaam-v3'].title).toBe('GigaAM v3')
  })

  test('voiceErrorText даёт текст для каждого кода; на darwin mic-denied про macOS и без Win+H', () => {
    for (const code of CODES) {
      expect(voiceErrorText(code, 'win32').length, code).toBeGreaterThan(0)
      expect(voiceErrorText(code, 'darwin').length, code).toBeGreaterThan(0)
    }
    expect(voiceErrorText('mic-denied', 'win32')).toContain('Windows')
    const mac = voiceErrorText('mic-denied', 'darwin')
    expect(mac).toContain('macOS')
    expect(mac).not.toContain('Windows')
    expect(voiceErrorText('engine-gave-up', 'win32')).toContain('Win+H')
    expect(voiceErrorText('engine-gave-up', 'darwin')).not.toContain('Win+H')
  })

  test('I2: engine-missing — про установку Qclod, а не «удалите модель»', () => {
    const text = voiceErrorText('engine-missing', 'win32')
    expect(text).toContain('Переустановите Qclod')
    expect(text).toContain('Win+H')
    expect(text).not.toMatch(/Удалите/)
    expect(voiceErrorText('engine-missing', 'darwin')).not.toContain('Win+H')
  })
})
