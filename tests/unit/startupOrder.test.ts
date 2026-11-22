import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'

const src = readFileSync(resolve(__dirname, '../../src/main/index.ts'), 'utf8')

/**
 * The start of src/main/index.ts has one permanent order (the comment above it
 * lists it). Each stage puts its piece in its own place and moves nobody else's.
 * A mark that is not in the file yet is optional; the stage that adds it takes
 * the flag off (`optional: false`).
 */
const ORDER: Array<{ mark: string; optional: boolean; stage: string }> = [
  { mark: 'runAskpassClient(', optional: false, stage: '6' },
  { mark: "app.setPath('userData'", optional: false, stage: '1' },
  { mark: 'installMainErrorHandlers(', optional: false, stage: '2' },
  { mark: 'claimSingleInstance(', optional: false, stage: '3' },
  { mark: 'appendSwitch(', optional: false, stage: '5' },
  { mark: 'app.whenReady(', optional: false, stage: '-' }
]

test('the marks of the start of index.ts stand in the agreed order', () => {
  // Marks are looked for in code, not in the comment that lists them.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const present = ORDER.filter((m) => {
    const found = code.includes(m.mark)
    if (!found && !m.optional) throw new Error(`${m.mark} is missing from src/main/index.ts`)
    return found
  })
  const positions = present.map((m) => code.indexOf(m.mark))
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
  expect(new Set(positions).size).toBe(positions.length)
})

test('the error log is made before the handlers that write to it', () => {
  expect(src.indexOf('new ErrorLog(')).toBeGreaterThan(-1)
  expect(src.indexOf('new ErrorLog(')).toBeLessThan(src.indexOf('installMainErrorHandlers('))
})
