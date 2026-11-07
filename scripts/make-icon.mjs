// Draws the app icon from the design tokens so it cannot drift from the UI,
// and so the repository carries no opaque binary nobody can regenerate.
// Output: build/icon.png (512x512, RGBA).
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SIZE = 512
const RADIUS = 112
const ACCENT = [0x6e, 0x8b, 0xff]
const GLOW = [0xb0, 0x7c, 0xff]
const BACKDROP = [0x0e, 0x10, 0x1c]

function roundedRectAlpha(x, y, left, top, right, bottom, radius) {
  // Distance to the rounded-rectangle edge, anti-aliased over one pixel.
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - cx
  const dy = y - cy
  const distance = Math.hypot(dx, dy)
  return Math.min(Math.max(radius - distance + 0.5, 0), 1)
}

function mix(a, b, t) {
  return a.map((channel, i) => Math.round(channel + (b[i] - channel) * t))
}

function pixels() {
  const rows = []
  for (let y = 0; y < SIZE; y++) {
    const row = Buffer.alloc(SIZE * 4 + 1)
    row[0] = 0 // filter: none
    for (let x = 0; x < SIZE; x++) {
      const outer = roundedRectAlpha(x + 0.5, y + 0.5, 0, 0, SIZE, SIZE, RADIUS)
      const diagonal = (x / SIZE + y / SIZE) / 2
      const plate = mix(BACKDROP, mix(ACCENT, GLOW, diagonal), 0.18)

      // The mark: a smaller rounded square in the accent gradient.
      const markInset = SIZE * 0.3
      const mark = roundedRectAlpha(
        x + 0.5,
        y + 0.5,
        markInset,
        markInset,
        SIZE - markInset,
        SIZE - markInset,
        RADIUS * 0.42
      )
      const color = mix(plate, mix(ACCENT, GLOW, diagonal), mark)

      const at = 1 + x * 4
      row[at] = color[0]
      row[at + 1] = color[1]
      row[at + 2] = color[2]
      row[at + 3] = Math.round(outer * 255)
    }
    rows.push(row)
  }
  return Buffer.concat(rows)
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, crc])
}

let crcTable
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let crc = -1
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return crc ^ -1
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(pixels(), { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = resolve(process.cwd(), 'build')
mkdirSync(out, { recursive: true })
writeFileSync(resolve(out, 'icon.png'), png)
console.log(`build/icon.png — ${SIZE}x${SIZE}, ${png.length} bytes`)
