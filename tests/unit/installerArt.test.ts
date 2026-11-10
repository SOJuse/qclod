import { describe, expect, test } from 'vitest'
// @ts-expect-error plain .mjs helper, same as scripts/releaseSeams.mjs
import { encodeBmp24, readAccent, drawSidebar, drawHeader, GRAPHITE } from '../../scripts/installerArt.mjs'

type Rgb = [number, number, number]

function pixelAt(bmp: Buffer, x: number, y: number): Rgb {
  const width = bmp.readInt32LE(18)
  const height = bmp.readInt32LE(22)
  const stride = Math.ceil((width * 3) / 4) * 4
  const at = bmp.readUInt32LE(10) + (height - 1 - y) * stride + x * 3
  return [bmp[at + 2]!, bmp[at + 1]!, bmp[at]!]
}

describe('картинки установщика', () => {
  test('encodeBmp24 пишет корректный заголовок и строки снизу вверх', () => {
    const bmp: Buffer = encodeBmp24(164, 314, () => [0, 0, 0])
    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM')
    expect(bmp.length).toBe(54 + 492 * 314)
    expect(bmp.readInt32LE(18)).toBe(164)
    expect(bmp.readInt32LE(22)).toBe(314)
    expect(bmp.readUInt16LE(28)).toBe(24)
  })

  test('encodeBmp24 дополняет строку до 4 байт, верхний левый пиксель в последней строке в порядке BGR', () => {
    const bmp: Buffer = encodeBmp24(3, 2, (x: number, y: number) => (x === 0 && y === 0 ? [1, 2, 3] : [9, 9, 9]))
    expect(bmp.length).toBe(54 + 12 * 2)
    expect([...bmp.subarray(54 + 12, 54 + 12 + 3)]).toEqual([3, 2, 1])
  })

  test('readAccent берёт hex из tokens.css и отвергает не-hex', () => {
    expect(readAccent(':root { --accent: #6e8bff; }')).toEqual([0x6e, 0x8b, 0xff])
    expect(() => readAccent('--accent: rgba(1,2,3,1)')).toThrow()
  })

  test('drawSidebar: фон, акцентная третья полоса, размер', () => {
    const bmp: Buffer = drawSidebar([255, 0, 0])
    expect(bmp.length).toBe(54 + 492 * 314)
    expect(pixelAt(bmp, 10, 10)).toEqual([0x0f, 0x0f, 0x11])
    expect(GRAPHITE.bg).toBe('#0f0f11')
    expect(pixelAt(bmp, 56, 249)).toEqual([255, 0, 0])
  })

  test('drawHeader: размер 150x57', () => {
    const bmp: Buffer = drawHeader([255, 0, 0])
    expect(bmp.readInt32LE(18)).toBe(150)
    expect(bmp.readInt32LE(22)).toBe(57)
  })
})
