import { describe, expect, test } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const SRC = join(ROOT, 'src')
const RELAY = join(SRC, 'relay')

type Exists = (path: string) => boolean

/** Every module a file names (the same patterns as coreBoundary.test.ts). */
function specifiers(source: string): string[] {
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

/** The file a relative or aliased specifier names, or null for a package or node:*. */
function resolveSpec(from: string, spec: string, exists: Exists): string | null {
  let base: string
  if (spec.startsWith('.')) base = resolve(dirname(from), spec)
  else if (spec.startsWith('@shared/')) base = join(SRC, 'shared', spec.slice('@shared/'.length))
  else if (spec.startsWith('@main/')) base = join(SRC, 'main', spec.slice('@main/'.length))
  else if (spec.startsWith('@renderer/')) base = join(SRC, 'renderer', spec.slice('@renderer/'.length))
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (/\.(tsx?|m?js)$/.test(candidate) && exists(candidate)) return candidate
  }
  return `${base}.ts`
}

function under(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel))
}

/**
 * Every file reachable from `entries` through imports, and what is wrong with
 * the walk: electron, the renderer or the ribbon translator reached, with the
 * chain that got there.
 */
export function walk(entries: string[], read: (file: string) => string, exists: Exists): { files: string[]; problems: string[] } {
  const seen = new Map<string, string[]>()
  const problems: string[] = []
  const queue: Array<{ file: string; chain: string[] }> = entries.map((file) => ({ file, chain: [file] }))
  while (queue.length > 0) {
    const { file, chain } = queue.shift()!
    if (seen.has(file)) continue
    seen.set(file, chain)
    const path = chain.map((f) => relative(ROOT, f)).join(' → ')
    if (under(file, join(SRC, 'renderer'))) problems.push(`renderer: ${path}`)
    if (file === join(SRC, 'shared', 'ribbon.ts')) problems.push(`ribbon.ts: ${path}`)
    if (!exists(file)) continue
    for (const spec of specifiers(read(file))) {
      if (spec === 'electron' || spec.startsWith('electron/')) {
        problems.push(`electron: ${path}`)
        continue
      }
      const target = resolveSpec(file, spec, exists)
      if (target) queue.push({ file: target, chain: [...chain, target] })
    }
  }
  return { files: [...seen.keys()], problems }
}

describe('граница посредника (сверка F2)', () => {
  test('от src/relay не достижимы electron, src/renderer и ribbon.ts', () => {
    const entries = readdirSync(RELAY)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(RELAY, name))
    // main.ts is the relay's entry point; every other file is walked too.
    expect(entries.length).toBeGreaterThan(0)
    const { files, problems } = walk(entries, (f) => readFileSync(f, 'utf8'), existsSync)
    expect(problems).toEqual([])
    // The pure modules of main it may use are reached, so the walk is real.
    const reached = files.map((f) => relative(SRC, f).split(sep).join('/'))
    expect(reached).toContain('main/agent/permissionStore.ts')
    expect(reached).toContain('main/agent/questionAnswer.ts')
    expect(reached).toContain('main/agent/sdkDriver.ts')
    expect(reached).toContain('core/autonomy/AutonomyCore.ts')
  })

  test('страж ловит запрещённое через цепочку', () => {
    const files: Record<string, string> = {
      [join(RELAY, 'main.ts')]: "import { a } from './daemon'\nimport '@shared/ribbon'",
      [join(RELAY, 'daemon.ts')]: "import { b } from '../main/agent/x'\nimport { c } from 'node:fs'",
      [join(SRC, 'main', 'agent', 'x.ts')]: "import { app } from 'electron'\nimport { d } from '../../renderer/y'",
      [join(SRC, 'renderer', 'y.ts')]: '',
      [join(SRC, 'shared', 'ribbon.ts')]: ''
    }
    const { problems } = walk([join(RELAY, 'main.ts')], (f) => files[f] ?? '', (f) => f in files)
    expect(problems).toHaveLength(3)
    expect(problems.find((p) => p.startsWith('electron:'))).toContain('src/relay/daemon.ts → src/main/agent/x.ts'.replace(/\//g, sep))
    expect(problems.some((p) => p.startsWith('renderer:'))).toBe(true)
    expect(problems.some((p) => p.startsWith('ribbon.ts:'))).toBe(true)
  })
})
