import { describe, expect, test } from 'vitest'
import {
  FrameTooLarge,
  LineDecoder,
  MAX_FRAME_BYTES,
  RELAY_DRIVER_OPS,
  RELAY_PROTO,
  encodeFrame,
  parseFrame,
  type RelayFrame
} from '../../src/shared/relayProtocol'

const FRAMES: RelayFrame[] = [
  { t: 'hello', proto: 1, app: '1.0.0', client: 'pc' },
  { t: 'welcome', proto: 1, relay: '1.0.0', binary: '1.0.0', startedAt: 1700000000000 },
  { t: 'req', id: 7, m: 'session.open', p: { cwd: '~/app', mode: 'default' } },
  { t: 'req', id: 8, m: 'git.run', p: { cwd: '/x', args: ['status'], timeoutMs: 1000, maxBytes: 10 } },
  { t: 'res', id: 7, ok: true, r: { snapshot: { s: 'a' }, gap: false } },
  { t: 'res', id: 8, ok: false, e: { code: 'unsupported', message: 'нет' } },
  { t: 'ev', s: 'a', q: 1, k: 'sdk', at: 5, d: { type: 'result' } },
  { t: 'ev', s: 'a', q: 2, k: 'sent', at: 6, d: { input: { text: 'привет' } } },
  { t: 'ev', s: 'a', q: 3, k: 'notice', at: 7, d: { kind: 'text', text: 'x', tone: 'error' } },
  { t: 'live', s: 'a', k: 'stream', d: { type: 'stream_event' } },
  { t: 'live', s: 'a', k: 'closed', d: null },
  { t: 'ping' },
  { t: 'pong' }
]

describe('кадры протокола посредника', () => {
  test('RELAY_PROTO = 1, строка не больше 16 МиБ', () => {
    expect(RELAY_PROTO).toBe(1)
    expect(MAX_FRAME_BYTES).toBe(16 * 1024 * 1024)
  })

  test('parseFrame(encodeFrame(f)) равен f для каждого вида кадра', () => {
    for (const frame of FRAMES) {
      const line = encodeFrame(frame)
      expect(line.endsWith('\n')).toBe(true)
      expect(line.slice(0, -1)).not.toContain('\n')
      expect(parseFrame(line)).toEqual(frame)
    }
  })

  test('мусор и неверная форма дают null', () => {
    expect(parseFrame('{"t":"ev","s":"a","q":0}')).toBeNull()
    expect(parseFrame('{"t":"ev","s":"a","q":0,"k":"sdk","at":1,"d":null}')).toBeNull()
    expect(parseFrame('{"t":"req","id":"x"}')).toBeNull()
    expect(parseFrame('мусор')).toBeNull()
    expect(parseFrame('')).toBeNull()
    expect(parseFrame('null')).toBeNull()
    expect(parseFrame('[1]')).toBeNull()
    expect(parseFrame('{"t":"req","id":1,"m":"rm.rf","p":{}}')).toBeNull()
    expect(parseFrame('{"t":"res","id":1,"ok":false,"e":{"code":"teapot","message":"x"}}')).toBeNull()
    expect(parseFrame('{"t":"ev","s":"a","q":1.5,"k":"sdk","at":1,"d":null}')).toBeNull()
    expect(parseFrame('{"t":"ev","s":"","q":1,"k":"sdk","at":1,"d":null}')).toBeNull()
    expect(parseFrame('{"t":"live","s":"a","k":"secret","d":null}')).toBeNull()
    expect(parseFrame('{"t":"hello","proto":"1","app":"a","client":"b"}')).toBeNull()
  })

  test('лишние поля кадра не проходят дальше', () => {
    const frame = parseFrame('{"t":"ping","evil":1}')
    expect(frame).toEqual({ t: 'ping' })
    expect(Object.keys(frame!)).toEqual(['t'])
  })

  test('encodeFrame кадра > 16 МиБ бросает FrameTooLarge', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES)
    expect(() => encodeFrame({ t: 'live', s: 'a', k: 'stream', d: big })).toThrow(FrameTooLarge)
  })

  test('RELAY_DRIVER_OPS — без messages и dispose, с backgroundTask', () => {
    expect(RELAY_DRIVER_OPS).toContain('send')
    expect(RELAY_DRIVER_OPS).toContain('backgroundTask')
    expect(RELAY_DRIVER_OPS as readonly string[]).not.toContain('messages')
    expect(RELAY_DRIVER_OPS as readonly string[]).not.toContain('dispose')
    expect(new Set(RELAY_DRIVER_OPS).size).toBe(RELAY_DRIVER_OPS.length)
  })
})

describe('LineDecoder', () => {
  const a: RelayFrame = { t: 'ping' }
  const b: RelayFrame = { t: 'live', s: 's1', k: 'status', d: { status: 'busy' } }

  test('два кадра в одном чанке', () => {
    const decoder = new LineDecoder()
    expect(decoder.push(encodeFrame(a) + encodeFrame(b))).toEqual([a, b])
  })

  test('кадр, разрезанный на три чанка', () => {
    const decoder = new LineDecoder()
    const line = encodeFrame(b)
    const third = Math.floor(line.length / 3)
    expect(decoder.push(line.slice(0, third))).toEqual([])
    expect(decoder.push(line.slice(third, third * 2))).toEqual([])
    expect(decoder.push(line.slice(third * 2))).toEqual([b])
  })

  test('кириллица, разрезанная посреди UTF-8', () => {
    const frame: RelayFrame = { t: 'ev', s: 's', q: 1, k: 'sent', at: 1, d: { text: 'Привет, мир' } }
    const bytes = Buffer.from(encodeFrame(frame), 'utf8')
    const at = bytes.indexOf(Buffer.from('р', 'utf8')) + 1 // inside the two bytes of «р»
    const decoder = new LineDecoder()
    expect(decoder.push(bytes.subarray(0, at))).toEqual([])
    expect(decoder.push(bytes.subarray(at))).toEqual([frame])
  })

  test('строка длиннее MAX_FRAME_BYTES отброшена целиком, следующий кадр читается', () => {
    const decoder = new LineDecoder()
    const chunk = Buffer.alloc(4 * 1024 * 1024, 0x61)
    for (let i = 0; i < 5; i++) expect(decoder.push(chunk)).toEqual([])
    expect(decoder.dropped).toBe(1)
    // the end of the oversized line, then a good frame in the same chunk
    expect(decoder.push(Buffer.concat([chunk, Buffer.from('\n' + encodeFrame(a))]))).toEqual([a])
    expect(decoder.dropped).toBe(1)
    expect(decoder.push(encodeFrame(b))).toEqual([b])
  })

  test('строка ровно с пределом в одном чанке с переводом строки тоже отбрасывается', () => {
    const decoder = new LineDecoder()
    const line = Buffer.concat([Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61), Buffer.from('\n' + encodeFrame(a))])
    expect(decoder.push(line)).toEqual([a])
    expect(decoder.dropped).toBe(1)
  })

  test('мусорная строка пропускается, остальные читаются', () => {
    const decoder = new LineDecoder()
    expect(decoder.push('мусор\n' + encodeFrame(a))).toEqual([a])
    expect(decoder.invalid).toBe(1)
  })
})
