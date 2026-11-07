import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bracketedPaste, drive, FAKE_AGENT, type Driver } from './helpers/pty'

const NODE = process.execPath
let current: Driver | undefined

function start(args: string[] = []): Driver {
  current = drive(NODE, [FAKE_AGENT, ...args])
  return current
}

afterEach(() => {
  current?.kill()
  current = undefined
})

describe('fake agent', () => {
  test('отвечает эхом на отправленную строку', async () => {
    const a = start()
    await a.waitFor('ready')
    a.write('hello there\r')
    const out = await a.waitFor('[submit 1]')
    expect(out).toContain('"hello there"')
  })

  test('многострочный bracketed paste приходит одним вводом', async () => {
    const a = start()
    await a.waitFor('ready')
    a.write(bracketedPaste('line one\nline two\nline three'))
    a.write('\r')
    const out = await a.waitFor('[submit 1]')
    expect(out).toContain(JSON.stringify('line one\nline two\nline three'))
    expect(out).not.toContain('[submit 2]')
  })

  test('/menu печатает три пункта и реагирует на стрелки', async () => {
    const a = start()
    await a.waitFor('ready')
    a.write('/menu\r')
    // The marker and the menu body are separate writes, so waiting for the
    // marker alone races the chunk boundary.
    await a.waitFor('❯ option-1')
    a.write('\x1b[B')
    await a.waitFor('❯ option-2')
    a.write('\r')
    const out = await a.waitFor('menu-selected')
    expect(out).toContain('menu-selected: option-2')
  })

  test('/exit 3 завершает процесс с кодом 3', async () => {
    const a = start()
    await a.waitFor('ready')
    a.write('/exit 3\r')
    await expect(a.exit).resolves.toBe(3)
  })

  test('зовёт команду хука Stop из --settings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-hook-'))
    const sink = join(dir, 'events.jsonl')
    const hookScript = join(dir, 'hook.js')
    writeFileSync(
      hookScript,
      `const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c);` +
        `process.stdin.on('end',()=>fs.appendFileSync(${JSON.stringify(sink)},d+'\\n'));`,
      'utf8'
    )
    const settings = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `"${NODE}" "${hookScript}"` }] }]
      }
    })

    const a = start(['--settings', settings])
    await a.waitFor('ready')
    a.write('ping\r')
    await a.waitFor('[submit 1]')

    const deadline = Date.now() + 6000
    while (!existsSync(sink) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(existsSync(sink)).toBe(true)
    const event = JSON.parse(readFileSync(sink, 'utf8').trim().split('\n')[0])
    expect(event.hook_event_name).toBe('Stop')
    expect(event.session_id).toBeTruthy()
  })
})
