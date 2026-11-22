import { describe, expect, test } from 'vitest'
// @ts-expect-error plain .mjs helper shared with scripts/relay-manifest.mjs
import { ASSET, manifestFrom } from '../../scripts/relayManifest.mjs'

const SHA_X = 'a'.repeat(64)
const SHA_A = 'B'.repeat(64)

describe('манифест посредника', () => {
  test('имя ассета qclod-relay-<version>-linux-<arch>.gz', () => {
    expect(ASSET.test('qclod-relay-1.0.0-linux-x64.gz')).toBe(true)
    expect(ASSET.test('qclod-relay-1.0.0-linux-arm64.gz')).toBe(true)
    expect(ASSET.test('qclod-relay-1.0.0-win-x64.gz')).toBe(false)
  })

  test('из строк sha256sum: имя, хеш, размер; чужая версия не берётся', () => {
    const manifest = manifestFrom('1.0.0', [
      { name: 'qclod-relay-1.0.0-linux-x64.gz', sha256Line: `${SHA_X}  qclod-relay-1.0.0-linux-x64.gz\n`, size: 43 },
      { name: 'qclod-relay-1.0.0-linux-arm64.gz', sha256Line: `${SHA_A}  qclod-relay-1.0.0-linux-arm64.gz`, size: 41 },
      { name: 'qclod-relay-0.9.0-linux-x64.gz', sha256Line: `${SHA_X}  x`, size: 1 }
    ])
    expect(manifest).toEqual({
      version: '1.0.0',
      assets: {
        x64: { name: 'qclod-relay-1.0.0-linux-x64.gz', sha256: SHA_X, size: 43 },
        arm64: { name: 'qclod-relay-1.0.0-linux-arm64.gz', sha256: SHA_A.toLowerCase(), size: 41 }
      }
    })
  })

  test('испорченный хеш — ошибка', () => {
    expect(() => manifestFrom('1.0.0', [{ name: 'qclod-relay-1.0.0-linux-x64.gz', sha256Line: 'xyz', size: 1 }])).toThrow()
  })
})
