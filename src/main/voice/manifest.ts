import { readFileSync } from 'node:fs'
import type { VoiceModelId } from '../../shared/voice'
import data from './manifest.data.json'

export interface ManifestFile {
  name: string
  size: number
  sha256: string
  /** First is the primary source, the last is our mirror. */
  urls: string[]
  unpack?: 'zip'
}

export interface ModelManifest {
  id: VoiceModelId
  version: number
  dir: string
  files: ManifestFile[]
}

/** A pre-release: an ordinary one would become the "latest" for electron-updater (decision 12). */
export const MIRROR_TAG = 'voice-models-v1'

export function mirrorUrl(asset: string): string {
  return `https://github.com/SOJuse/qclod/releases/download/${MIRROR_TAG}/${asset}`
}

export function mirrorAsset(dir: string, name: string): string {
  return `${dir}--${name}`
}

export const VAD_DIR: string = data.vad.dir

interface RawFile {
  name: string
  size: number
  sha256: string
  url: string
  unpack?: string
}

function build(dir: string, raw: RawFile): ManifestFile {
  const file: ManifestFile = {
    name: raw.name,
    size: raw.size,
    sha256: raw.sha256,
    urls: [raw.url, mirrorUrl(mirrorAsset(dir, raw.name))]
  }
  if (raw.unpack === 'zip') file.unpack = 'zip'
  return file
}

/** Shared by all models, lives in silero-vad/. */
export const VAD_FILE: ManifestFile = build(data.vad.dir, data.vad.file)

export const MANIFESTS: Record<VoiceModelId, ModelManifest> = Object.fromEntries(
  Object.entries(data.models).map(([id, m]) => [
    id,
    { id, version: m.version, dir: m.dir, files: m.files.map((f) => build(m.dir, f)) }
  ])
) as Record<VoiceModelId, ModelManifest>

interface FakeManifestFile {
  vad?: ManifestFile
  models?: Record<VoiceModelId, ModelManifest>
}

function fakeManifest(): FakeManifestFile | null {
  if (!__QCLOD_TEST_SEAMS__) return null
  const path = process.env['QCLOD_FAKE_VOICE_MANIFEST']
  if (!path) return null
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  // Same shape as MANIFESTS (model ids at the top level); an optional "vad" key replaces the VAD file.
  const { vad, ...models } = raw
  return { vad: vad as ManifestFile | undefined, models: models as Record<VoiceModelId, ModelManifest> }
}

/** MANIFESTS; for e2e a JSON file of the same shape (QCLOD_FAKE_VOICE_MANIFEST) replaces it. */
export function activeManifests(): Record<VoiceModelId, ModelManifest> {
  const fake = fakeManifest()
  return fake?.models ? { ...MANIFESTS, ...fake.models } : MANIFESTS
}

export function activeVad(): ManifestFile {
  return fakeManifest()?.vad ?? VAD_FILE
}
