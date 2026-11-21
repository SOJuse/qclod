import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { stripComments } from './cssTokens'

const css = stripComments(
  readFileSync(resolve(__dirname, '../../src/renderer/components/agents/AgentsLayer.css'), 'utf8')
)

/** The body of the `@media (prefers-reduced-motion: reduce)` block. */
function reducedBlock(): string {
  const at = css.indexOf('prefers-reduced-motion: reduce')
  expect(at).toBeGreaterThan(-1)
  const open = css.indexOf('{', at)
  let depth = 1
  let i = open + 1
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
  }
  return css.slice(open + 1, i - 1)
}

describe('AgentsLayer.css', () => {
  test('узел дышит, связь течёт', () => {
    expect(css).toMatch(/\.agent-node\.is-running[^{]*\{[^}]*animation:\s*agent-breathe 2\.4s ease-in-out infinite/)
    expect(css).toMatch(/\.agent-edge\.is-live\s*\{[^}]*stroke-dasharray:\s*6 6;[^}]*animation:\s*agent-flow 1\.2s linear infinite/)
    expect(css).toMatch(/@keyframes agent-flow\s*\{[^}]*stroke-dashoffset/)
  })

  test('в prefers-reduced-motion: reduce у .agent-node и .agent-edge — animation: none', () => {
    const block = reducedBlock()
    expect(block).toMatch(/\.agent-node[^{]*\{[^}]*animation:\s*none/)
    expect(block).toMatch(/\.agent-edge[^{]*\{[^}]*animation:\s*none/)
  })

  test('открытый край полосы таймлайна пульсирует и затихает при reduced motion', () => {
    expect(css).toMatch(/\.agent-bar\.is-open::after\s*\{[^}]*animation:\s*agent-pulse/)
    expect(reducedBlock()).toMatch(/\.agent-bar\.is-open::after\s*\{[^}]*animation:\s*none/)
  })
})
