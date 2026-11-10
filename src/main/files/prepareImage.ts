import { nativeImage, type NativeImage } from 'electron'
import type { PreparedImage } from '../../shared/types'
import { saveImageBuffer } from './imagePaste'

/** Longer sides are scaled down: the model sees no more detail past this anyway. */
export const MAX_IMAGE_SIDE = 2000
/** As base64 this is about 5 MB, the most the API takes for one image. */
export const MAX_IMAGE_BYTES = 3_750_000
/** The chip and the bubble show the picture this big by its longer side. */
const THUMB_SIDE = 160
/** 85 first; lower only for a screenshot so busy that 85 does not fit. */
const JPEG_QUALITIES = [85, 70, 55, 40]
/** Formats the bytes may stay in when nothing about them has to change. */
const KEEP_AS_IS = new Set(['image/png', 'image/jpeg'])

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

/**
 * A pasted image made fit to send: at most MAX_IMAGE_SIDE by its longer side
 * and MAX_IMAGE_BYTES in size, with a thumbnail for the chat and a copy in
 * userData/pastes that the user can open.
 *
 * A 4K screenshot is easily over the 5 MB the API accepts, and the message
 * would be refused whole; scaling it here keeps it sendable.
 */
export function prepareImage(
  userData: string,
  dataBase64: string,
  mediaType: string
): PreparedImage | { error: string } {
  const source = Buffer.from(dataBase64, 'base64')
  let image = nativeImage.createFromBuffer(source)
  if (image.isEmpty()) return { error: 'Не похоже на картинку' }

  const original = image.getSize()
  const fitted = fitWithin(original.width, original.height, MAX_IMAGE_SIDE)
  const resized = fitted.width !== original.width || fitted.height !== original.height
  if (resized) image = image.resize({ ...fitted, quality: 'best' })

  const out =
    !resized && KEEP_AS_IS.has(mediaType) && source.length <= MAX_IMAGE_BYTES
      ? { bytes: source, mediaType }
      : encode(image)
  if (!out) return { error: 'Картинка слишком большая' }

  const thumbSize = fitWithin(fitted.width, fitted.height, THUMB_SIDE)
  const thumbnail = image.resize(thumbSize).toDataURL()

  const path = saveImageBuffer(userData, out.bytes, out.mediaType === 'image/jpeg' ? 'jpg' : 'png')
  if (!path) return { error: 'Не похоже на картинку' }

  return {
    mediaType: out.mediaType,
    dataBase64: out.bytes === source ? dataBase64 : out.bytes.toString('base64'),
    thumbnail,
    path,
    width: fitted.width,
    height: fitted.height
  }
}
