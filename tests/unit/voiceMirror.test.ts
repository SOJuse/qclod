import { basename } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error plain .mjs without types
import * as mirror from '../../scripts/voiceMirror.mjs'
import { MANIFESTS, MIRROR_TAG, mirrorAsset, VAD_FILE } from '../../src/main/voice/manifest'

const files = [
  { dir: 'silero-vad', name: VAD_FILE.name },
  ...Object.values(MANIFESTS).flatMap((m) => m.files.map((f) => ({ dir: m.dir, name: f.name })))
]

describe('mirrorUploadArgs', () => {
  const args: string[] = mirror.mirrorUploadArgs(MIRROR_TAG, files, 'C:\\stage')

  test('a pre-release with the agreed tag, never "latest"', () => {
    expect(args.slice(0, 3)).toEqual(['release', 'create', 'voice-models-v1'])
    expect(args).toContain('--prerelease')
    expect(args.some((a) => a.includes('--latest'))).toBe(false)
  })

  test('every file goes under its mirror asset name', () => {
    for (const f of files) {
      const staged = args.find((a) => a.endsWith(mirrorAsset(f.dir, f.name)))
      expect(staged).toBeDefined()
      expect(basename(staged!.replaceAll('\\', '/'))).toBe(mirrorAsset(f.dir, f.name))
    }
  })

  test('the script and the app agree on names and tag', () => {
    expect(mirror.MIRROR_TAG).toBe(MIRROR_TAG)
    for (const f of files) expect(mirror.mirrorAsset(f.dir, f.name)).toBe(mirrorAsset(f.dir, f.name))
  })
})
