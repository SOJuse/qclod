import { delimiter } from 'node:path'
import { describe, expect, test } from 'vitest'
import { CHANNELS } from '../../src/shared/channels'
import { localShell, localTerminalEnv } from '../../src/main/ssh/localTerminal'
import { TerminalHub, type IPtyLike } from '../../src/main/ssh/terminal'

describe('оболочка локального терминала', () => {
  test('Windows: pwsh.exe, если он в PATH, иначе powershell.exe', () => {
    const has = (p: string) => p.includes('PS7') && p.endsWith('pwsh.exe')
    expect(localShell('win32', { PATH: ['/x', '/PS7'].join(delimiter) }, has).file).toMatch(/pwsh.exe$/)
    expect(localShell('win32', { PATH: '/x' }, () => false)).toEqual({ file: 'powershell.exe', args: [] })
  })
  test('Mac/Linux: $SHELL -l, иначе /bin/zsh', () => {
    expect(localShell('darwin', { SHELL: '/bin/bash' })).toEqual({ file: '/bin/bash', args: ['-l'] })
    expect(localShell('linux', {})).toEqual({ file: '/bin/zsh', args: ['-l'] })
  })
  test('окружение без переменных прокси', () => {
    const env = localTerminalEnv({ PATH: '/a', HTTP_PROXY: 'x', https_proxy: 'y', ALL_PROXY: 'z', NO_PROXY: 'n', HOME: '/h' })
    expect(env).toEqual({ PATH: '/a', HOME: '/h' })
  })
})

describe('локальный терминал в хабе', () => {
  function setup() {
    const made: Array<{ file: string; o: Record<string, unknown>; killed: boolean }> = []
    const sent: Array<[string, unknown]> = []
    const h = new TerminalHub({
      spawnPty: ((file: string, _a: string[], o: Record<string, unknown>) => {
        const rec = { file, o, killed: false }
        made.push(rec)
        const pty: IPtyLike = { onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, kill: () => void (rec.killed = true) }
        return pty
      }) as never,
      send: (ch, p) => sent.push([ch, p])
    })
    return { h, made, sent }
  }
  test('cwd — папка вкладки', () => {
    const { h, made } = setup()
    h.start('t1', 'sh', ['-l'], { cols: 80, rows: 24 }, {}, undefined, '/proj')
    expect(made[0]!.o['cwd']).toBe('/proj')
  })
  test('closeTab закрывает локальный терминал', () => {
    const { h, made } = setup()
    const id = h.start('t1', 'sh', [], { cols: 80, rows: 24 }, {}, undefined, '/proj')
    h.closeTab('t1')
    expect(made[0]!.killed).toBe(true)
    expect(h.has(id)).toBe(false)
    expect(CHANNELS.terminalExit).toBeTruthy()
  })
})
