import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * nativeImage stands in as a small model: a size, and bytes whose length the
 * test chooses for each encoding. That is all prepareImage decides on.
 */
interface FakeImage {
  isEmpty: () => boolean
  getSize: () => { width: number; height: number }
  resize: (size: { width: number; height?: number }) => FakeImage
  toPNG: () => Buffer
  toJPEG: (quality: number) => Buffer
  toDataURL: () => string
}

const encoded = vi.hoisted(() => ({ pngBytes: 1000, jpegBytes: (_q: number): number => 500 }))
const calls = vi.hoisted(() => ({ resize: [] as Array<{ width: number; height?: number }>, jpeg: [] as number[] }))

function fakeImage(width: number, height: number): FakeImage {
  return {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: (size) => {
      calls.resize.push(size)
      return fakeImage(size.width, size.height ?? height)
    },
    toPNG: () => Buffer.alloc(encoded.pngBytes, 1),
    toJPEG: (quality) => {
      calls.jpeg.push(quality)
      return Buffer.alloc(encoded.jpegBytes(quality), 2)
    },
    toDataURL: () => `data:image/png;base64,thumb${width}x${height}`
  }
}

/** The test encodes the size it wants as the first bytes: "WxH". */
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (buf: Buffer) => {
      const match = /^(\d+)x(\d+)/.exec(buf.toString('latin1'))
      return match ? fakeImage(Number(match[1]), Number(match[2])) : fakeImage(0, 0)
    }
  }
}))

import { fitWithin, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, prepareImage } from '@main/files/prepareImage'
import { PASTE_DIR_NAME } from '@main/files/imagePaste'

function source(width: number, height: number, padTo = 0): string {
  const head = Buffer.from(`${width}x${height}`, 'latin1')
  return Buffer.concat([head, Buffer.alloc(Math.max(0, padTo - head.length))]).toString('base64')
}

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'qclod-prep-'))
  encoded.pngBytes = 1000
  encoded.jpegBytes = () => 500
  calls.resize = []
  calls.jpeg = []
})
afterEach(() => rmSync(userData, { recursive: true, force: true }))

describe('fitWithin', () => {
  test('fitWithin уменьшает большую сторону до предела, сохраняя пропорции', () =>
    expect(fitWithin(3000, 2000, 2000)).toEqual({ width: 2000, height: 1333 }))

  test('маленькая картинка не растягивается', () =>
    expect(fitWithin(800, 600, 2000)).toEqual({ width: 800, height: 600 }))

  test('высокая картинка уменьшается по высоте; сторона не бывает нулём', () => {
    expect(fitWithin(1000, 4000, 2000)).toEqual({ width: 500, height: 2000 })
    expect(fitWithin(10000, 1, 2000)).toEqual({ width: 2000, height: 1 })
  })
})

describe('prepareImage', () => {
  test('пределы: 2000 по стороне и 3 750 000 байт', () => {
    expect(MAX_IMAGE_SIDE).toBe(2000)
    expect(MAX_IMAGE_BYTES).toBe(3_750_000)
  })

  test('не картинка — понятная ошибка, файла нет', () => {
    expect(prepareImage(userData, Buffer.from('просто текст').toString('base64'), 'image/png')).toEqual({
      error: 'Не похоже на картинку'
    })
    expect(existsSync(join(userData, PASTE_DIR_NAME))).toBe(false)
  })

  test('небольшой PNG уходит как есть и сохраняется в pastes', () => {
    const data = source(800, 600, 64)
    const out = prepareImage(userData, data, 'image/png')
    if ('error' in out) throw new Error(out.error)
    expect(out).toMatchObject({ mediaType: 'image/png', dataBase64: data, width: 800, height: 600 })
    expect(calls.resize).toEqual([{ width: 160, height: 120 }])
    expect(out.thumbnail).toBe('data:image/png;base64,thumb160x120')
    expect(out.path.startsWith(join(userData, PASTE_DIR_NAME))).toBe(true)
    expect(out.path.endsWith('.png')).toBe(true)
    expect(readFileSync(out.path).toString('base64')).toBe(data)
  })

  test('большой снимок уменьшается до 2000 по большей стороне', () => {
    const out = prepareImage(userData, source(3000, 2000), 'image/png')
    if ('error' in out) throw new Error(out.error)
    expect(calls.resize[0]).toEqual({ width: 2000, height: 1333, quality: 'best' })
    expect(out).toMatchObject({ mediaType: 'image/png', width: 2000, height: 1333 })
    expect(Buffer.from(out.dataBase64, 'base64').length).toBe(1000)
  })

  test('PNG больше предела байт становится JPEG качества 85 и файлом .jpg', () => {
    encoded.pngBytes = MAX_IMAGE_BYTES + 1
    const out = prepareImage(userData, source(1900, 1000, MAX_IMAGE_BYTES + 10), 'image/png')
    if ('error' in out) throw new Error(out.error)
    expect(calls.jpeg).toEqual([85])
    expect(out.mediaType).toBe('image/jpeg')
    expect(out.path.endsWith('.jpg')).toBe(true)
    expect(Buffer.from(out.dataBase64, 'base64').length).toBe(500)
  })

  test('если и JPEG 85 велик, качество снижается, пока не влезет', () => {
    encoded.pngBytes = MAX_IMAGE_BYTES + 1
    encoded.jpegBytes = (q) => (q >= 70 ? MAX_IMAGE_BYTES + 1 : 900)
    const out = prepareImage(userData, source(2000, 2000, MAX_IMAGE_BYTES + 10), 'image/png')
    if ('error' in out) throw new Error(out.error)
    expect(calls.jpeg[0]).toBe(85)
    expect(out.mediaType).toBe('image/jpeg')
    expect(Buffer.from(out.dataBase64, 'base64').length).toBe(900)
  })

  test('то, что не влезает ни в каком качестве, не уходит', () => {
    encoded.pngBytes = MAX_IMAGE_BYTES + 1
    encoded.jpegBytes = () => MAX_IMAGE_BYTES + 1
    expect(prepareImage(userData, source(2000, 2000, MAX_IMAGE_BYTES + 10), 'image/png')).toEqual({
      error: 'Картинка слишком большая'
    })
  })
})
