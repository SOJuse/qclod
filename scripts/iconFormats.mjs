// Pure encoders for the app-icon containers. Both formats carry PNG payloads,
// so there is no pixel work here — only the container layout.

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
export const TRAY_SIZES = [16, 24, 32]

// Pixel size of the PNG each ICNS type must hold. The @2x types hold the
// doubled size of their base: ic13 = 128@2x = 256 px, ic14 = 256@2x = 512 px.
export const ICNS_TYPES = {
  icp4: 16,
  icp5: 32,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32,
  ic12: 64,
  ic13: 256,
  ic14: 512
}

/** images: {size, png: Buffer}[] — one PNG-compressed ICO entry each. */
export function encodeIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(0, 0) // reserved
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i
    head[at] = size >= 256 ? 0 : size // 0 means 256
    head[at + 1] = size >= 256 ? 0 : size
    head[at + 2] = 0 // palette
    head[at + 3] = 0
    head.writeUInt16LE(1, at + 4) // colour planes
    head.writeUInt16LE(32, at + 6) // bits per pixel
    head.writeUInt32LE(png.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map((image) => image.png)])
}

/** entries: {type, png: Buffer}[] — big-endian "icns" container of PNG entries. */
export function encodeIcns(entries) {
  const parts = entries.map(({ type, png }) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 4, 'ascii')
    head.writeUInt32BE(8 + png.length, 4)
    return Buffer.concat([head, png])
  })
  const total = 8 + parts.reduce((sum, part) => sum + part.length, 0)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 4, 'ascii')
  head.writeUInt32BE(total, 4)
  return Buffer.concat([head, ...parts])
}

/** The alpha channel of a size×size RGBA buffer. */
export function alphaOf(rgba, size) {
  const alpha = new Uint8Array(size * size)
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]
  return alpha
}
