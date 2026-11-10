import { describe, expect, test } from 'vitest'
// @ts-expect-error plain .mjs helper, same as scripts/releaseSeams.mjs
import { tagMatchesVersion } from '../../scripts/releaseTag.mjs'

describe('tagMatchesVersion', () => {
  test('accepts exactly v plus the version', () => {
    expect(tagMatchesVersion('v0.2.0', '0.2.0')).toBe(true)
  })
  test('rejects a tag without the v', () => {
    expect(tagMatchesVersion('0.2.0', '0.2.0')).toBe(false)
  })
  test('rejects another version', () => {
    expect(tagMatchesVersion('v0.2.1', '0.2.0')).toBe(false)
  })
  test('rejects a suffixed tag', () => {
    expect(tagMatchesVersion('v0.2.0-beta', '0.2.0')).toBe(false)
  })
})
