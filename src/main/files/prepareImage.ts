import { nativeImage, type NativeImage } from 'electron'
import type { PreparedImage } from '../../shared/types'
import { saveImageBuffer, type PasteExt } from './imagePaste'

/** Longer sides are scaled down: the model sees no more detail past this anyway. */
export const MAX_IMAGE_SIDE = 2000
/** As base64 this is about 5 MB, the most the API takes for one image. */
export const MAX_IMAGE_BYTES = 3_750_000
/** A picture bigger than this by either side is not decoded at all: its pixels alone run to gigabytes. */
export const MAX_SOURCE_SIDE = 16_384
/** Nor one this big by area: 16384 × 16384 within the side limit is still a gigabyte of pixels. */
export const MAX_SOURCE_PIXELS = 100_000_000
/** Nor is a paste this heavy. */
export const MAX_SOURCE_BYTES = 50 * 1024 * 1024
/** The chip and the bubble show the picture this big by its longer side. */
const THUMB_SIDE = 160
/** A thumbnail is an inline picture; a longer one is not kept (sanitizeInput's limit). */
const MAX_THUMBNAIL = 200_000
/** 85 first; lower only for a screenshot so busy that 85 does not fit. */
const JPEG_QUALITIES = [85, 70, 55, 40]

const EXT: Record<string, PasteExt> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/**
 * The image type the bytes themselves say, or null. The clipboard's or the
 * file's own word for it is not trusted: a renamed file would reach the API
 * under a type it is not, and be refused there.
 */
export function sniffImageType(bytes: Buffer): string | null {
  const at = (offset: number, text: string): boolean =>
    bytes.length >= offset + text.length && bytes.toString('latin1', offset, offset + text.length) === text
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 'PNG\r\n\x1a\n')) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  return null
}

/**
 * The size a PNG or JPEG says it is, read from its header without decoding
 * it. Null when the header does not say (the decoder then decides).
 */
export function headerSize(bytes: Buffer, type: string): { width: number; height: number } | null {
  if (type === 'image/png') {
    if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (type !== 'image/jpeg') return null
  // Segments follow SOI; the first start-of-frame carries the size.
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    if (marker === 0xff) {
      at += 1
      continue
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      if (at + 9 > bytes.length) return null
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) }
    }
    at += 2 + bytes.readUInt16BE(at + 2)
  }
  return null
}

/** A size no larger than `max` by its longer side, in the same proportions. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longer = Math.max(width, height)
  if (longer <= max) return { width, height }
  const scale = max / longer
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function encode(image: NativeImage): { bytes: Buffer; mediaType: string } | null {
  const png = image.toPNG()
  if (png.length <= MAX_IMAGE_BYTES) return { bytes: png, mediaType: 'image/png' }
  for (const quality of JPEG_QUALITIES) {
    const jpeg = image.toJPEG(quality)
    if (jpeg.length <= MAX_IMAGE_BYTES) return { bytes: jpeg, mediaType: 'image/jpeg' }
  }
  return null
}

function save(userData: string, bytes: Buffer, mediaType: string): string | null {
  return saveImageBuffer(userData, bytes, EXT[mediaType] ?? 'png')
}

/**
 * A pasted image made fit to send: at most MAX_IMAGE_SIDE by its longer side
 * and MAX_IMAGE_BYTES in size, with a thumbnail for the chat and a copy in
 * userData/pastes. The bytes stay in main: the copy's path stands for them,
 * and they are read from it when the message goes.
 *
 * A 4K screenshot is easily over the 5 MB the API accepts, and the message
 * would be refused whole; scaling it here keeps it sendable. GIF and WebP,
 * which nativeImage cannot read, go as they are when small enough.
 */
export function prepareImage(
  userData: string,
  dataBase64: string,
  _claimedType: string
): PreparedImage | { error: string } {
  const source = Buffer.from(dataBase64, 'base64')
  const type = sniffImageType(source)
  if (!type) return { error: 'Не похоже на картинку' }
  if (source.length > MAX_SOURCE_BYTES) return { error: 'Картинка слишком большая' }
  const declared = headerSize(source, type)
  if (
    declared &&
    (Math.max(declared.width, declared.height) > MAX_SOURCE_SIDE ||
      declared.width * declared.height > MAX_SOURCE_PIXELS)
  ) {
    return { error: 'Картинка слишком большая' }
  }

  if (type === 'image/gif' || type === 'image/webp') {
    if (source.length > MAX_IMAGE_BYTES) return { error: 'Картинка слишком большая' }
    const path = save(userData, source, type)
    if (!path) return { error: 'Не похоже на картинку' }
    const inline = `data:${type};base64,${dataBase64}`
    return {
      mediaType: type,
      thumbnail: inline.length <= MAX_THUMBNAIL ? inline : '',
      path,
      width: 0,
      height: 0
    }
  }

  let image = nativeImage.createFromBuffer(source)
  if (image.isEmpty()) return { error: 'Не похоже на картинку' }

  const original = image.getSize()
  const fitted = fitWithin(original.width, original.height, MAX_IMAGE_SIDE)
  const resized = fitted.width !== original.width || fitted.height !== original.height
  if (resized) image = image.resize({ ...fitted, quality: 'best' })

  const out = !resized && source.length <= MAX_IMAGE_BYTES ? { bytes: source, mediaType: type } : encode(image)
  if (!out) return { error: 'Картинка слишком большая' }

  const thumbnail = image.resize(fitWithin(fitted.width, fitted.height, THUMB_SIDE)).toDataURL()

  const path = save(userData, out.bytes, out.mediaType)
  if (!path) return { error: 'Не похоже на картинку' }

  return { mediaType: out.mediaType, thumbnail, path, width: fitted.width, height: fitted.height }
}
