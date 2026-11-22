import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const CORE = join(ROOT, 'src', 'core')
const SHARED = join(ROOT, 'src', 'shared')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...tsFiles(path))
    else if (/\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

/** Every module a file names: import/export … from, bare import, require(), import(). */
export function specifiers(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]!)
  }
  return found
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel))
}

/** Why a core file may not name this module, or null when it may. */
function forbidden(file: string, spec: string): string | null {
  if (spec.startsWith('node:')) return null
  if (spec.startsWith('.')) {
    const target = resolve(dirname(file), spec)
    if (inside(target, CORE) || inside(target, SHARED)) return null
    return 'outside src/core and src/shared'
  }
  if (spec.startsWith('@shared/')) return null
  return 'not a relative path, src/shared or node:*'
}

describe('граница ядра', () => {
  test('src/core не зависит от Electron, main и renderer', () => {
    const files = tsFiles(CORE)
    expect(files.length).toBeGreaterThan(0)
    const problems: string[] = []
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const why = forbidden(file, spec)
        if (why) problems.push(`${relative(ROOT, file)}: ${spec} — ${why}`)
      }
    }
    expect(problems).toEqual([])
  })

  test('src/shared не импортирует electron', () => {
    const problems: string[] = []
    for (const file of tsFiles(SHARED)) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        if (spec === 'electron' || spec.startsWith('electron/')) problems.push(relative(ROOT, file))
      }
    }
    expect(problems).toEqual([])
  })

  test('страж ловит запрещённое', () => {
    const file = join(CORE, 'autonomy', 'x.ts')
    const source = [
      "import { app } from 'electron'",
      "import type { X } from '../../main/agent/AgentSession'",
      "export { y } from '@main/y'",
      "import '@renderer/z'",
      "const a = require('electron')",
      "const b = await import('../../renderer/App')",
      "import { ok } from './types'",
      "import { readFileSync } from 'node:fs'",
      "import type { PanelData } from '../../shared/types'"
    ].join('\n')
    const bad = specifiers(source).filter((spec) => forbidden(file, spec) !== null)
    expect(bad).toEqual([
      'electron',
      '../../main/agent/AgentSession',
      '@main/y',
      '@renderer/z',
      'electron',
      '../../renderer/App'
    ])
  })
})
