import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(__dirname, '../..')

describe('scaffold', () => {
  test('main entry points at the built output', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    expect(pkg.main).toBe('./out/main/index.js')
  })

  test('window is created without a frame and with context isolation', () => {
    const source = readFileSync(resolve(root, 'src/main/window.ts'), 'utf8')
    expect(source).toContain('frame: false')
    expect(source).toContain('contextIsolation: true')
    expect(source).toContain('nodeIntegration: false')
    expect(source).toContain("backgroundMaterial: 'acrylic'")
  })
})
