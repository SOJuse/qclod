// Pure parts of scripts/voice-mirror.mjs (like releaseTag.mjs): what goes where.
import { join } from 'node:path'

export const MIRROR_TAG = 'voice-models-v1'
export const MIRROR_REPO = 'SOJuse/qclod'

/** Same as mirrorAsset in src/main/voice/manifest.ts (a test keeps them equal). */
export function mirrorAsset(dir, name) {
  return `${dir}--${name}`
}

/** Where a manifest file is staged before the upload: the asset name is the file name, `gh` takes it from there. */
export function stagedPath(stagingDir, dir, name) {
  return join(stagingDir, mirrorAsset(dir, name))
}

/**
 * `gh` arguments for the mirror release. It is a PRE-release on purpose: an
 * ordinary one would become the "latest" that electron-updater reads and would
 * break the friends' updates. There is no --latest here.
 * @param {string} tag
 * @param {Array<{ dir: string, name: string }>} files
 * @param {string} stagingDir
 */
export function mirrorUploadArgs(tag, files, stagingDir) {
  return [
    'release',
    'create',
    tag,
    '--repo',
    MIRROR_REPO,
    '--prerelease',
    '--title',
    'Voice models mirror',
    '--notes',
    'Mirror of the voice model files (Qclod downloads them from here when the main source fails). Not an app release.',
    ...files.map((f) => stagedPath(stagingDir, f.dir, f.name))
  ]
}
