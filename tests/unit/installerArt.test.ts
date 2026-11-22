import { readFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, test } from 'vitest'
// @ts-expect-error plain .mjs helper, same as scripts/releaseSeams.mjs
import { encodeBmp24, readAccent, drawSidebar, drawHeader, GRAPHITE } from '../../scripts/installerArt.mjs'

type Rgb = [number, number, number]

// The mark is rasterised from the master SVG, exactly as make-installer-art does.
function renderMark(size: number): { rgba: Uint8Array; size: number } {
  const svg = readFileSync('build/brand/qclod.svg', 'utf8')
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render()
  return { rgba: new Uint8Array(image.pixels), size }
}

// CIE76 deltaE of two sRGB colours.
function deltaE(a: Rgb, b: Rgb): number {
  const lab = ([r, g, bl]: Rgb): Rgb => {
    const lin = (c: number): number => {
      const v = c / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    const [R, G, B] = [lin(r), lin(g), lin(bl)] as Rgb
    const xyz: Rgb = [
      (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047,
      0.2126 * R + 0.7152 * G + 0.0722 * B,
      (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883
    ]
    const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
    const [fx, fy, fz] = xyz.map(f) as Rgb
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
  }
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

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
    const bmp: Buffer = drawSidebar([255, 0, 0], renderMark(72))
    expect(bmp.length).toBe(54 + 492 * 314)
    expect(pixelAt(bmp, 10, 10)).toEqual([0x0f, 0x0f, 0x11])
    expect(GRAPHITE.bg).toBe('#0f0f11')
    expect(pixelAt(bmp, 56, 249)).toEqual([255, 0, 0])
  })

  test('drawHeader: размер 150x57', () => {
    const bmp: Buffer = drawHeader([255, 0, 0], renderMark(36))
    expect(bmp.readInt32LE(18)).toBe(150)
    expect(bmp.readInt32LE(22)).toBe(57)
  })

  test('drawSidebar: в центре марки a-orbit пиксель заметно отличается от фона (ΔE > 15)', () => {
    const bmp: Buffer = drawSidebar([255, 0, 0], renderMark(72))
    expect(deltaE(pixelAt(bmp, 16 + 36, 16 + 36), pixelAt(bmp, 10, 10))).toBeGreaterThan(15)
  })

  test('drawHeader: в центре марки пиксель заметно отличается от фона (ΔE > 15)', () => {
    const bmp: Buffer = drawHeader([255, 0, 0], renderMark(36))
    expect(deltaE(pixelAt(bmp, 4 + 18, 10 + 18), pixelAt(bmp, 1, 1))).toBeGreaterThan(15)
  })
})

describe('фон DMG', () => {
  test('PNG 540x380, графитовый фон, акцентная стрелка между значками', async () => {
    const { deflateSync, inflateSync } = await import('node:zlib')
    // @ts-expect-error plain .mjs helper
    const { drawDmgBackground } = await import('../../scripts/installerArt.mjs')
    const png: Buffer = drawDmgBackground([255, 0, 0], renderMark(48), deflateSync)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.readUInt32BE(16)).toBe(540)
    expect(png.readUInt32BE(20)).toBe(380)
    const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8)
    const raw = inflateSync(idat)
    expect(raw.length).toBe((540 * 3 + 1) * 380)
    const at = (x: number, y: number): number[] => {
      const i = y * (540 * 3 + 1) + 1 + x * 3
      return [raw[i]!, raw[i + 1]!, raw[i + 2]!]
    }
    expect(at(500, 100)).toEqual([0x0f, 0x0f, 0x11])
    expect(at(260, 190)).toEqual([255, 0, 0])
  })

  test('закоммиченный build/dmgBackground.png: 540x380', () => {
    const png = readFileSync('build/dmgBackground.png')
    expect(png.readUInt32BE(16)).toBe(540)
    expect(png.readUInt32BE(20)).toBe(380)
  })
})
