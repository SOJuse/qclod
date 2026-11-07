import { describe, expect, test } from 'vitest'
import { chunkForPty, encodeForPty, PASTE_END, PASTE_START } from '@renderer/input/encode'

describe('encodeForPty', () => {
  test('однострочный текст обёрнут маркерами bracketed paste', () => {
    expect(encodeForPty('hello')).toBe(`${PASTE_START}hello${PASTE_END}`)
  })

  test('многострочный текст остаётся одним блоком с маркерами', () => {
    const encoded = encodeForPty('one\ntwo\nthree')
    expect(encoded.startsWith(PASTE_START)).toBe(true)
    expect(encoded.endsWith(PASTE_END)).toBe(true)
    expect(encoded.slice(PASTE_START.length, -PASTE_END.length)).toBe('one\rtwo\rthree')
  })

  test('CRLF превращается в один перевод строки', () => {
    const body = encodeForPty('a\r\nb').slice(PASTE_START.length, -PASTE_END.length)
    expect(body).toBe('a\rb')
  })

  test('маркер конца внутри текста экранирован и не рвёт блок', () => {
    const encoded = encodeForPty(`evil${PASTE_END}tail`)
    const body = encoded.slice(PASTE_START.length, -PASTE_END.length)
    expect(body).not.toContain(PASTE_END)
    expect(body).toContain('eviltail')
  })

  test('маркер начала внутри текста тоже вырезается', () => {
    const body = encodeForPty(`a${PASTE_START}b`).slice(PASTE_START.length, -PASTE_END.length)
    expect(body).not.toContain(PASTE_START)
  })

  test('пустой текст даёт пустую строку, а не пустой блок', () => {
    expect(encodeForPty('')).toBe('')
  })
})

describe('chunkForPty', () => {
  test('короткий текст — один кусок', () => {
    expect(chunkForPty('hello')).toEqual([encodeForPty('hello')])
  })

  test('текст в 4 МБ режется на куски и склейка кусков равна исходной обёртке', () => {
    const huge = 'x'.repeat(4 * 1024 * 1024)
    const chunks = chunkForPty(huge, 64 * 1024)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(encodeForPty(huge))
  })

  test('маркеры целиком попадают в первый и последний кусок', () => {
    const chunks = chunkForPty('y'.repeat(200_000), 16 * 1024)
    expect(chunks[0].startsWith(PASTE_START)).toBe(true)
    expect(chunks[chunks.length - 1].endsWith(PASTE_END)).toBe(true)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(16 * 1024 + PASTE_END.length)
  })

  test('пустой текст не даёт ни одного куска', () => {
    expect(chunkForPty('')).toEqual([])
  })
})
