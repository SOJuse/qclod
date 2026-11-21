import { describe, expect, test } from 'vitest'
import { CHANNELS } from '../../src/shared/channels'
import { TERM_BACKLOG_MAX, TERM_INPUT_MAX, TerminalHub, shellCommand, termSize, type IPtyLike } from '../../src/main/ssh/terminal'

/** A pty that records what it is told and can be made to exit. */
function fakePty() {
  const made: Array<{ file: string; args: string[]; o: Record<string, unknown>; pty: IPtyLike & { exit(code: number): void; data(d: string): void } }> = []
  const spawnPty = (file: string, args: string[], o: Record<string, unknown>) => {
    let onData: (d: string) => void = () => undefined
    let onExit: (e: { exitCode: number }) => void = () => undefined
    const written: string[] = []
    const sizes: Array<[number, number]> = []
    let killed = false
    const pty = {
      onData: (cb: (d: string) => void) => void (onData = cb),
      onExit: (cb: (e: { exitCode: number }) => void) => void (onExit = cb),
      write: (d: string) => void written.push(d),
      resize: (c: number, r: number) => void sizes.push([c, r]),
      kill: () => void (killed = true),
      exit: (code: number) => onExit({ exitCode: code }),
      data: (d: string) => onData(d),
      get written() {
        return written
      },
      get sizes() {
        return sizes
      },
      get killed() {
        return killed
      }
    }
    made.push({ file, args, o, pty })
    return pty
  }
  return { made, spawnPty }
}

function hub() {
  const fake = fakePty()
  const sent: Array<[string, unknown]> = []
  const h = new TerminalHub({
    spawnPty: fake.spawnPty as never,
    send: (ch, payload) => sent.push([ch, payload]),
    sshPath: 'ssh',
    platform: 'linux',
    userData: '/ud',
    uid: 1000
  })
  return { h, fake, sent }
}

describe('терминал сервера', () => {
  test('аргументы: -tt, хост, -- и cd <путь через shq> && exec "$SHELL" -l', () => {
    const { h, fake } = hub()
    h.open('t1', { target: 'u@box', port: 2222 }, "/srv/o'k app", { SSH_ASKPASS: '/a' }, { cols: 100, rows: 30 })
    const { file, args, o } = fake.made[0]!
    expect(file).toBe('ssh')
    expect(args[0]).toBe('-tt')
    expect(args).toContain('ForwardAgent=no')
    expect(args.slice(-3)).toEqual(['u@box', '--', `cd '/srv/o'\\''k app' && exec "$SHELL" -l`])
    expect(o).toMatchObject({ cols: 100, rows: 30, name: 'xterm-256color' })
    expect((o['env'] as Record<string, string>)['SSH_ASKPASS']).toBe('/a')
  })

  test('~ и ~/… раскрывает сервер', () => {
    expect(shellCommand('~')).toBe('cd ~ && exec "$SHELL" -l')
    expect(shellCommand('~/my app')).toBe(`cd ~/'my app' && exec "$SHELL" -l`)
  })

  test('input больше 64 КиБ отвергнут', () => {
    const { h, fake } = hub()
    const id = h.open('t1', { target: 'box' }, '/srv', {}, { cols: 80, rows: 24 })
    expect(h.input(id, 'ls\r')).toBe(true)
    expect(h.input(id, 'x'.repeat(TERM_INPUT_MAX + 1))).toBe(false)
    expect(h.input('чужой', 'ls')).toBe(false)
    expect((fake.made[0]!.pty as unknown as { written: string[] }).written).toEqual(['ls\r'])
  })

  test('resize вне границ отвергнут', () => {
    const { h, fake } = hub()
    const id = h.open('t1', { target: 'box' }, '/srv', {}, { cols: 80, rows: 24 })
    expect(h.resize(id, 120, 40)).toBe(true)
    expect(h.resize(id, 1, 40)).toBe(false)
    expect(h.resize(id, 501, 40)).toBe(false)
    expect(h.resize(id, 120, 201)).toBe(false)
    expect(h.resize(id, 80.5, 24)).toBe(false)
    expect((fake.made[0]!.pty as unknown as { sizes: unknown[] }).sizes).toEqual([[120, 40]])
    expect(termSize(2, 2)).toEqual({ cols: 2, rows: 2 })
    expect(termSize(500, 200)).toEqual({ cols: 500, rows: 200 })
  })

  test('closeTab убивает все терминалы вкладки', () => {
    const { h, fake } = hub()
    const ended: string[] = []
    const a = h.open('t1', { target: 'box' }, '/srv', {}, { cols: 80, rows: 24 }, () => ended.push('a'))
    const b = h.open('t1', { target: 'box' }, '/srv', {}, { cols: 80, rows: 24 }, () => ended.push('b'))
    const c = h.open('t2', { target: 'box' }, '/srv', {}, { cols: 80, rows: 24 })
    h.closeTab('t1')
    const killed = fake.made.map((m) => (m.pty as unknown as { killed: boolean }).killed)
    expect(killed).toEqual([true, true, false])
    expect([h.has(a), h.has(b), h.has(c)]).toEqual([false, false, true])
    expect(ended).toEqual(['a', 'b'])
  })

  test('вывод — terminalData, выход pty — terminalExit; после выхода терминала нет', () => {
    const { h, fake, sent } = hub()
    const ended: string[] = []
    const id = h.open('t1', { target: 'box' }, '/srv', {}, { cols: 80, rows: 24 }, () => ended.push(id))
    fake.made[0]!.pty.data('привет')
    fake.made[0]!.pty.exit(0)
    expect(sent).toEqual([
      [CHANNELS.terminalData, { termId: id, data: 'привет' }],
      [CHANNELS.terminalExit, { termId: id, exitCode: 0 }]
    ])
    expect(ended).toEqual([id])
    expect(h.has(id)).toBe(false)
    expect(h.input(id, 'x')).toBe(false)
  })
})

describe('терминал сервера переживает уход панели (R1)', () => {
  test('attach отдаёт накопленный вывод той же вкладке; чужой вкладке и после выхода — null', () => {
    const { h, fake } = hub()
    const id = h.open('t1', { target: 'box' }, '/srv', {}, { cols: 80, rows: 24 })
    fake.made[0]!.pty.data('$ ls\r\n')
    fake.made[0]!.pty.data('a b\r\n')
    expect(h.attach('t1', id)).toBe('$ ls\r\na b\r\n')
    expect(h.attach('t2', id)).toBeNull()
    expect(h.attach('t1', '0b9a6c2e-4f1d-4a7b-9c3e-1d2f3a4b5c6d')).toBeNull()
    fake.made[0]!.pty.exit(0)
    expect(h.attach('t1', id)).toBeNull()
  })

  test('буфер — последние 256 КБ вывода', () => {
    const { h, fake } = hub()
    const id = h.open('t1', { target: 'box' }, '/srv', {}, { cols: 80, rows: 24 })
    const chunk = 'x'.repeat(100 * 1024)
    for (let i = 0; i < 4; i++) fake.made[0]!.pty.data(chunk)
    fake.made[0]!.pty.data('конец')
    const backlog = h.attach('t1', id)!
    expect(backlog.length).toBe(TERM_BACKLOG_MAX)
    expect(backlog.endsWith('xконец')).toBe(true)
  })
})
