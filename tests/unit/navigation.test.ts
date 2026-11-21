import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeNavigationGuard } from '@main/security'

// The guard turns these into real paths of the platform it runs on, so the
// fixtures are paths of that platform and their URLs are derived from them.
const renderer =
  process.platform === 'win32'
    ? 'C:\\Users\\user\\qclod\\out\\renderer\\'
    : '/Users/user/qclod/out/renderer/'
const appFile = renderer + 'index.html'
const fallbackFile = renderer + 'fallback.html'

describe('makeNavigationGuard (packaged, file://)', () => {
  const allowed = makeNavigationGuard(undefined, [appFile, fallbackFile])

  test('the app page itself is allowed', () => {
    expect(allowed(pathToFileURL(appFile).href)).toBe(true)
  })

  test('a hash or query on the app page is allowed', () => {
    expect(allowed(`${pathToFileURL(appFile).href}#/settings`)).toBe(true)
  })

  test('the fallback page is allowed', () => {
    expect(allowed(pathToFileURL(fallbackFile).href)).toBe(true)
  })

  test('another file next to them is rejected', () => {
    expect(allowed('file:///C:/Users/user/qclod/out/renderer/other.html')).toBe(false)
  })

  test('another local file is rejected', () => {
    expect(allowed('file:///C:/Windows/System32/drivers/etc/hosts')).toBe(false)
  })

  test('a UNC path with the same tail is rejected', () => {
    expect(allowed('file://evil.example.com/C:/Users/user/qclod/out/renderer/index.html')).toBe(
      false
    )
  })

  test('a remote page is rejected', () => {
    expect(allowed('https://evil.example.com/')).toBe(false)
  })

  test('unparseable input is rejected', () => {
    expect(allowed('::::')).toBe(false)
  })
})

describe('makeNavigationGuard (dev server)', () => {
  const allowed = makeNavigationGuard('http://localhost:5173', [appFile, fallbackFile])

  test('the dev origin is allowed', () => {
    expect(allowed('http://localhost:5173/index.html')).toBe(true)
  })

  test('a lookalike prefix on another host is rejected', () => {
    expect(allowed('http://localhost:5173.evil.com/')).toBe(false)
  })

  test('a different port is rejected', () => {
    expect(allowed('http://localhost:5174/')).toBe(false)
  })
})

describe('window wiring', () => {
  const source = readFileSync(resolve(__dirname, '../../src/main/window.ts'), 'utf8')

  test('the guard covers redirects and subframes too', () => {
    expect(source).toContain("'will-navigate'")
    expect(source).toContain("'will-redirect'")
    expect(source).toContain("'will-frame-navigate'")
  })
})

