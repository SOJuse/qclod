import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'

const root = resolve(__dirname, '../..')

// Built from pieces, so this file does not trip itself.
const MARKER = new RegExp(`^(${'<'.repeat(7)}|${'='.repeat(7)}|${'>'.repeat(7)})( |$)`, 'm')

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : files(path)
    return /\.(tsx?|mjs|cjs|js|css|json|md|html)$/.test(e.name) ? [path] : []
  })
}

/** Lines left over from a merge: `<<<<<<< ours`, `=======`, `>>>>>>> theirs`, at the start of a line. */
function conflictLines(text: string): number[] {
  return text
    .split('\n')
    .map((line, i) => [line.replace(/\r$/, ''), i + 1] as const)
    .filter(([line]) => MARKER.test(line))
    .map(([, n]) => n)
}

test('правило ловит все три метки конфликта и только в начале строки', () => {
  const sample = ['a', `${'<'.repeat(7)} HEAD`, 'b', '='.repeat(7), 'c', `${'>'.repeat(7)} main`, `  ${'='.repeat(7)}`, '='.repeat(8)]
  expect(conflictLines(sample.join('\n'))).toEqual([2, 4, 6])
})

test('в src/ и tests/ нет меток конфликта слияния', () => {
  const found = ['src', 'tests'].flatMap((dir) =>
    files(join(root, dir)).flatMap((f) => conflictLines(readFileSync(f, 'utf8')).map((n) => `${f}:${n}`))
  )
  expect(found).toEqual([])
})
