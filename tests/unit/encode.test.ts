import { describe, expect, test } from 'vitest'
import { chunkForPty, encodeForPty, PASTE_END, PASTE_START } from '@renderer/input/encode'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const NUL = String.fromCharCode(0)

function body(encoded: string): string {
  return encoded.slice(PASTE_START.length, encoded.length - PASTE_END.length)
}

describe('encodeForPty', () => {
  test('однострочный текст обёрнут маркерами bracketed paste', () => {
    expect(encodeForPty('hello')).toBe(`${PASTE_START}hello${PASTE_END}`)
  })

  test('многострочный текст остаётся одним блоком с маркерами', () => {
    const encoded = encodeForPty('one\ntwo\nthree')
    expect(encoded.startsWith(PASTE_START)).toBe(true)
    expect(encoded.endsWith(PASTE_END)).toBe(true)
    expect(body(encoded)).toBe('one\rtwo\rthree')
  })

  test('CRLF превращается в один перевод строки', () => {
    expect(body(encodeForPty('a\r\nb'))).toBe('a\rb')
  })

  test('маркер конца внутри текста обезврежен и не рвёт блок', () => {
    // The ESC is removed, which is what makes it harmless; the remaining "[201~"
    // stays as visible text rather than silently eating five of the user's
    // characters.
    const encoded = encodeForPty(`evil${PASTE_END}tail`)
    expect(body(encoded)).not.toContain(PASTE_END)
    expect(body(encoded)).not.toContain(ESC)
    expect(body(encoded)).toBe('evil[201~tail')
  })

  test('маркер начала внутри текста тоже обезврежен', () => {
    const result = body(encodeForPty(`a${PASTE_START}b`))
    expect(result).not.toContain(PASTE_START)
    expect(result).not.toContain(ESC)
  })

  test('вложенный маркер не собирается обратно после очистки', () => {
    // Removing PASTE_END from "ESC[20<PASTE_END>1~" rejoins the halves into a
    // working marker, so a single naive pass is not enough.
    const encoded = encodeForPty(`${ESC}[20${PASTE_END}1~ tail`)
    expect(body(encoded)).not.toContain(PASTE_END)
    expect(body(encoded)).not.toContain(ESC)
    expect(encoded.indexOf(PASTE_END)).toBe(encoded.length - PASTE_END.length)
  })

  test('пустой текст даёт пустую строку, а не пустой блок', () => {
    expect(encodeForPty('')).toBe('')
  })

  test('любые управляющие последовательности из буфера обмена вырезаются', () => {
    // Clipboard content is attacker-influenceable: a page can put escape
    // sequences there, and the agent would otherwise receive them verbatim.
    const result = body(encodeForPty(`safe${ESC}]0;pwned${BEL} text${NUL}end`))
    expect(result).not.toContain(ESC)
    expect(result).not.toContain(BEL)
    expect(result).not.toContain(NUL)
    expect(result).toContain('safe')
    expect(result).toContain('end')
  })

  test('перевод строки и табуляция переживают очистку', () => {
    expect(body(encodeForPty('a\tb\nc'))).toBe('a\tb\rc')
  })
})

describe('encodeForPty: вредоносная вставка не вешает интерфейс', () => {
  /**
   * Each nesting level reconstructs a fresh marker when the inner one is
   * removed, so a cleanup that loops until stable costs one full pass per
   * level — quadratic in the payload. This is the shape that took seconds on
   * the renderer's main thread; the mitigation must not be the denial of
   * service.
   */
  function nestedMarkers(depth: number): string {
    let text = PASTE_END
    for (let i = 0; i < depth; i++) text = `${ESC}[20${text}1~`
    return text
  }

  test('глубоко вложенные маркеры обрабатываются быстро и начисто', () => {
    const payload = nestedMarkers(20000)
    const started = Date.now()
    const encoded = encodeForPty(payload)
    const elapsed = Date.now() - started

    expect(elapsed).toBeLessThan(500)
    expect(body(encoded)).not.toContain(PASTE_END)
    expect(body(encoded)).not.toContain(ESC)
  })

  test('десять мегабайт обычного текста кодируются быстро', () => {
    const started = Date.now()
    encodeForPty('a'.repeat(10 * 1024 * 1024))
    expect(Date.now() - started).toBeLessThan(2000)
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
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(16 * 1024 + PASTE_END.length)
    }
  })

  test('пустой текст не даёт ни одного куска', () => {
    expect(chunkForPty('')).toEqual([])
  })
})

describe('chunkForPty очищает так же, как encodeForPty', () => {
  // Every paste path calls chunkForPty, not encodeForPty, so the guarantee has
  // to be pinned here too. Passing immediately is the point: this exists so the
  // sanitising step cannot be dropped from chunkForPty without a red test.
  test('управляющие символы вырезаются и в кусках', () => {
    const chunks = chunkForPty(`safe${ESC}]0;pwned${BEL}${NUL} end`)
    const joined = chunks.join('')
    expect(joined.slice(PASTE_START.length, -PASTE_END.length)).not.toContain(ESC)
    expect(joined).not.toContain(BEL)
    expect(joined).not.toContain(NUL)
  })

  test('вложенные маркеры не переживают нарезку', () => {
    const chunks = chunkForPty(`${ESC}[20${PASTE_END}1~ tail`)
    const joined = chunks.join('')
    expect(joined.indexOf(PASTE_END)).toBe(joined.length - PASTE_END.length)
  })

  test('двойное кодирование было бы ошибкой, а не защитой', () => {
    // chunkForPty(encodeForPty(x)) strips the inner ESCs and leaves literal
    // "[200~" junk in the user's text — the shape a reviewer suggested.
    const doubled = chunkForPty(encodeForPty('привет')).join('')
    expect(doubled).toContain('[200~')
    expect(chunkForPty('привет').join('')).toBe(encodeForPty('привет'))
  })
})
