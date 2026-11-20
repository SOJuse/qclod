import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error plain .mjs helper shared with scripts/make-icon.mjs
import { encodeIco, encodeIcns, alphaOf, ICO_SIZES, ICNS_TYPES, TRAY_SIZES } from '../../scripts/iconFormats.mjs'

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A minimal PNG-shaped buffer: signature + IHDR with the given size. */
function fakePng(size: number, pad = 0): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(size, 8)
  ihdr.writeUInt32BE(size, 12)
  return Buffer.concat([PNG_HEAD, ihdr, Buffer.alloc(pad, 1)])
}

function pngWidth(png: Buffer): number {
  expect(png.subarray(0, 8).equals(PNG_HEAD)).toBe(true)
  return png.readUInt32BE(16)
}

describe('encodeIco', () => {
  const images = (ICO_SIZES as number[]).map((size, i) => ({ size, png: fakePng(size, 10 + i) }))
  const ico: Buffer = encodeIco(images)

  test('заголовок: ICONDIR на 7 картинок', () => {
    expect(ICO_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256])
    expect([...ico.subarray(0, 6)]).toEqual([0, 0, 1, 0, 7, 0])
  })
  test('у записи 256 ширина и высота — 0', () => {
    const entry = ico.subarray(6 + 16 * 6, 6 + 16 * 7)
    expect(entry[0]).toBe(0)
    expect(entry[1]).toBe(0)
    expect(ico[6]).toBe(16)
  })
  test('смещение первой картинки — 6 + 16*7, размеры записей равны длинам PNG', () => {
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 16 * 7)
    let offset = 6 + 16 * 7
    images.forEach((image, i) => {
      const entry = 6 + 16 * i
      expect(ico.readUInt32LE(entry + 8)).toBe(image.png.length)
      expect(ico.readUInt32LE(entry + 12)).toBe(offset)
      expect(ico.subarray(offset, offset + image.png.length).equals(image.png)).toBe(true)
      offset += image.png.length
    })
    expect(offset).toBe(ico.length)
  })
})

describe('encodeIcns', () => {
  test('заголовок icns, длина big-endian, первая запись — icp4', () => {
    const icns: Buffer = encodeIcns([
      { type: 'icp4', png: fakePng(16) },
      { type: 'icp5', png: fakePng(32) }
    ])
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    expect(icns.subarray(8, 12).toString('ascii')).toBe('icp4')
    expect(icns.readUInt32BE(12)).toBe(8 + fakePng(16).length)
  })
  test('таблица типов: ic13 — 256 px, ic14 — 512 px (Apple: 128@2x и 256@2x)', () => {
    expect(ICNS_TYPES).toEqual({
      icp4: 16, icp5: 32, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
      ic11: 32, ic12: 64, ic13: 256, ic14: 512
    })
  })
})

describe('alphaOf', () => {
  test('RGBA 2×2 → 4 байта альфы', () => {
    const rgba = new Uint8Array([1, 2, 3, 10, 4, 5, 6, 20, 7, 8, 9, 30, 1, 1, 1, 40])
    expect([...alphaOf(rgba, 2)]).toEqual([10, 20, 30, 40])
  })
})

describe('сгенерированные файлы', () => {
  test('каждая запись ICNS содержит PNG того размера, который требует её тип', () => {
    const icns = readFileSync(resolve(__dirname, '../../build/icon.icns'))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
    const seen: string[] = []
    for (let at = 8; at < icns.length; ) {
      const type = icns.subarray(at, at + 4).toString('ascii')
      const length = icns.readUInt32BE(at + 4)
      expect(pngWidth(icns.subarray(at + 8, at + length))).toBe((ICNS_TYPES as Record<string, number>)[type])
      seen.push(type)
      at += length
    }
    expect(seen).toEqual(Object.keys(ICNS_TYPES))
  })
  test('каждая запись ICO содержит PNG заявленного размера', () => {
    const ico = readFileSync(resolve(__dirname, '../../build/icon.ico'))
    ;(ICO_SIZES as number[]).forEach((size, i) => {
      const entry = 6 + 16 * i
      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(pngWidth(ico.subarray(offset, offset + length))).toBe(size)
    })
  })
  test('build/icon.png — 1024 px', () => {
    expect(pngWidth(readFileSync(resolve(__dirname, '../../build/icon.png')))).toBe(1024)
    expect(TRAY_SIZES).toEqual([16, 24, 32])
  })
})
