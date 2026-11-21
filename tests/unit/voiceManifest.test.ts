import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { VOICE_MODEL_IDS } from '../../src/shared/voice'
import {
  activeManifests,
  MANIFESTS,
  MIRROR_TAG,
  mirrorAsset,
  mirrorUrl,
  VAD_FILE,
  type ManifestFile
} from '../../src/main/voice/manifest'

const all = (): Array<{ dir: string; f: ManifestFile }> => [
  { dir: 'silero-vad', f: VAD_FILE },
  ...VOICE_MODEL_IDS.flatMap((id) => MANIFESTS[id].files.map((f) => ({ dir: MANIFESTS[id].dir, f })))
]

describe('manifest', () => {
  test('every file has a SHA-256 and a size', () => {
    for (const { f } of all()) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(f.size).toBeGreaterThan(0)
    }
  })

  test('first url is https, the last is our mirror', () => {
    for (const { dir, f } of all()) {
      expect(f.urls[0]).toMatch(/^https:\/\//)
      expect(f.urls.at(-1)).toBe(mirrorUrl(mirrorAsset(dir, f.name)))
    }
    expect(mirrorUrl('x')).toBe(`https://github.com/SOJuse/qclod/releases/download/${MIRROR_TAG}/x`)
    expect(MIRROR_TAG).toBe('voice-models-v1')
  })

  test('mirror asset names are unique across models', () => {
    const names = all().map(({ dir, f }) => mirrorAsset(dir, f.name))
    expect(new Set(names).size).toBe(names.length)
  })

  test('GigaAM + VAD weigh 225 to 240 MB', () => {
    const mb = (MANIFESTS['gigaam-v3'].files.reduce((s, f) => s + f.size, 0) + VAD_FILE.size) / 1e6
    expect(mb).toBeGreaterThan(225)
    expect(mb).toBeLessThan(240)
  })

  test('pinned sources: VAD, whisper.cpp b5454, the zip is unpacked', () => {
    expect(VAD_FILE.size).toBe(643854)
    const w = MANIFESTS['whisper-turbo-cuda'].files
    expect(w.find((f) => f.unpack === 'zip')?.urls[0]).toContain('/b5454/')
    expect(w.find((f) => f.name.endsWith('.bin'))?.size).toBe(574041195)
  })
})

describe('activeManifests', () => {
  afterEach(() => vi.unstubAllEnvs())
  test('QCLOD_FAKE_VOICE_MANIFEST replaces the manifest of a model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-man-'))
    try {
      const p = join(dir, 'm.json')
      const fake = { id: 'gigaam-v3', version: 9, dir: 'gigaam-v3', files: [] }
      writeFileSync(p, JSON.stringify({ 'gigaam-v3': fake }))
      expect(activeManifests()['gigaam-v3'].version).toBe(1)
      vi.stubEnv('QCLOD_FAKE_VOICE_MANIFEST', p)
      expect(activeManifests()['gigaam-v3'].version).toBe(9)
      expect(activeManifests()['parakeet-v3']).toBe(MANIFESTS['parakeet-v3'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
