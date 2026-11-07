import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isSafeExternalUrl } from '@main/security'

describe('isSafeExternalUrl', () => {
  test('https is allowed', () => {
    expect(isSafeExternalUrl('https://code.claude.com/docs')).toBe(true)
  })

  test('http is allowed', () => {
    expect(isSafeExternalUrl('http://localhost:5173/')).toBe(true)
  })

  test('file urls are rejected', () => {
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
  })

  test('custom protocol handlers are rejected', () => {
    expect(isSafeExternalUrl('ms-msdt:/id PCWDiagnostic')).toBe(false)
  })

  test('javascript urls are rejected', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
  })

  test('unparseable input is rejected instead of throwing', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
  })
})

describe('window hardening', () => {
  const source = readFileSync(
    resolve(__dirname, '../../src/main/window.ts'),
    'utf8'
  )

  test('renderer runs sandboxed', () => {
    expect(source).toContain('sandbox: true')
  })

  test('navigation away from the app is blocked', () => {
    expect(source).toContain("'will-navigate'")
  })

  test('webview attachment is rejected', () => {
    expect(source).toContain("'will-attach-webview'")
  })
})
