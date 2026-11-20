import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ErrorLog } from '../../src/main/system/errorLog'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qclod-log-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ErrorLog', () => {
  test('a line is valid JSON in qclod.log', () => {
    const log = new ErrorLog(dir)
    log.write({ source: 'renderer', scope: 'pane', message: 'boom', stack: 's', at: 1 })
    log.write({ source: 'main', message: 'two', at: 2 })
    const lines = readFileSync(join(dir, 'qclod.log'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ source: 'renderer', scope: 'pane', message: 'boom' })
    expect(JSON.parse(lines[1]!).at).toBe(2)
  })

  test('over maxBytes the file rotates to qclod.1.log and only `keep` old ones stay', () => {
    const log = new ErrorLog(dir, { maxBytes: 100, keep: 2 })
    for (let i = 0; i < 12; i++) log.write({ source: 'main', message: 'x'.repeat(60) + i, at: i })
    const files = readdirSync(dir).sort()
    expect(files).toEqual(['qclod.1.log', 'qclod.2.log', 'qclod.log'])
    expect(JSON.parse(readFileSync(join(dir, 'qclod.log'), 'utf8').trim().split('\n').pop()!).at).toBe(11)
  })

  test('a failing write does not throw', () => {
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    const log = new ErrorLog(join(blocker, 'logs'))
    expect(() => log.write({ source: 'main', message: 'm', at: 1 })).not.toThrow()
  })
})
