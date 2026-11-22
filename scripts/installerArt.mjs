// Pure drawing helpers for the NSIS wizard artwork (sidebar and header BMPs).
// Motif: the Qclod ribbon - chat-like bars of different lengths, one in the
// accent colour, and the a-orbit app mark, rasterised from the master SVG.

export const GRAPHITE = { bg: '#0f0f11', surface: '#16161a', raised: '#1d1d22', line: '#26262d' }

function hex(color) {
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
}

// Copied from make-icon.mjs on purpose: that file belongs to another stage.
function roundedRectAlpha(x, y, left, top, right, bottom, radius) {
  // Distance to the rounded-rectangle edge, anti-aliased over one pixel.
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - cx
  const dy = y - cy
  const distance = Math.hypot(dx, dy)
  return Math.min(Math.max(radius - distance + 0.5, 0), 1)
}

export function encodeBmp24(width, height, pixel) {
  const stride = Math.ceil((width * 3) / 4) * 4
  const pixelBytes = stride * height
  const out = Buffer.alloc(54 + pixelBytes)
  out.write('BM', 0, 'ascii')
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22) // positive: rows go bottom-up
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(0, 30)
  out.writeUInt32LE(pixelBytes, 34)
  out.writeInt32LE(2835, 38)
  out.writeInt32LE(2835, 42)
  for (let y = 0; y < height; y++) {
    const rowStart = 54 + (height - 1 - y) * stride
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      const at = rowStart + x * 3
      out[at] = b
      out[at + 1] = g
      out[at + 2] = r
    }
  }
  return out
}

export function readAccent(tokensCss) {
  const match = /--accent:\s*#([0-9a-fA-F]{6})\s*;/.exec(tokensCss)
  if (!match) throw new Error('--accent in tokens.css must be a #rrggbb colour')
  return hex('#' + match[1])
}

function mix(base, top, alpha) {
  return base.map((channel, i) => Math.round(channel + (top[i] - channel) * alpha))
}

// shapes: [{ left, top, right, bottom, radius, color }], painted in order.
// Then the mark ({ rgba, size }, as rendered by resvg: premultiplied alpha)
// is laid over at placement { left, top }.
function paint(width, height, shapes, mark, placement) {
  const bg = hex(GRAPHITE.bg)
  return encodeBmp24(width, height, (x, y) => {
    let color = bg
    for (const s of shapes) {
      const alpha = roundedRectAlpha(x + 0.5, y + 0.5, s.left, s.top, s.right, s.bottom, s.radius)
      if (alpha > 0) color = mix(color, s.color, alpha)
    }
    const mx = x - placement.left
    const my = y - placement.top
    if (mx >= 0 && my >= 0 && mx < mark.size && my < mark.size) {
      const at = (my * mark.size + mx) * 4
      const keep = 1 - mark.rgba[at + 3] / 255
      color = color.map((channel, i) => Math.round(channel * keep + mark.rgba[at + i]))
    }
    return color
  })
}

function bar(left, top, width, height, color) {
  return { left, top, right: left + width, bottom: top + height, radius: height / 2 > 3 ? 3 : height / 2, color }
}

export function drawSidebar(accent, mark) {
  const widths = [96, 120, 72, 108, 56]
  const neutral = [hex(GRAPHITE.raised), hex(GRAPHITE.line)]
  const bottom = 280
  const shapes = []
  widths.forEach((w, i) => {
    const top = bottom - 6 - (widths.length - 1 - i) * 14
    shapes.push(bar(20, top, w, 6, i === 2 ? accent : neutral[i % 2]))
  })
  return paint(164, 314, shapes, mark, { left: 16, top: 16 })
}

export function drawHeader(accent, mark) {
  const neutral = [hex(GRAPHITE.raised), hex(GRAPHITE.line)]
  const shapes = []
  const widths = [64, 44, 54]
  widths.forEach((w, i) => {
    shapes.push(bar(42, 15 + i * 11, w, 5, i === 1 ? accent : neutral[i % 2]))
  })
  return paint(150, 57, shapes, mark, { left: 4, top: 10 })
}

// ---- DMG window background (540x380 PNG) ------------------------------------
// Graphite, the a-orbit mark at the top left, a few ribbon bars, and an arrow
// from where the app icon sits (x 140) to where the «Программы» alias sits (x 400).

export const DMG_SIZE = { width: 540, height: 380 }
/** Where electron-builder puts the app icon and the Applications alias (electron-builder.yml `dmg.contents`). */
export const DMG_ICON_Y = 190

function crc32(buf) {
  let c
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** An opaque 8-bit RGB PNG from a pixel function. */
export function encodePngRgb(width, height, pixel, deflate) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflate(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function segmentAlpha(x, y, ax, ay, bx, by, half) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0), 1)
  const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
  return Math.min(Math.max(half - d + 0.5, 0), 1)
}

/** `deflate` is zlib's deflateSync, passed in so this file stays free of imports. */
export function drawDmgBackground(accent, mark, deflate) {
  const { width, height } = DMG_SIZE
  const bg = hex(GRAPHITE.bg)
  const neutral = [hex(GRAPHITE.raised), hex(GRAPHITE.line)]
  const shapes = [
    bar(32, 332, 120, 6, neutral[0]),
    bar(32, 346, 84, 6, neutral[1]),
    bar(32, 318, 96, 6, neutral[1]),
    bar(width - 32 - 70, 346, 70, 6, neutral[0])
  ]
  const markAt = { left: 28, top: 24 }
  return encodePngRgb(
    width,
    height,
    (x, y) => {
      let color = bg
      for (const s of shapes) {
        const alpha = roundedRectAlpha(x + 0.5, y + 0.5, s.left, s.top, s.right, s.bottom, s.radius)
        if (alpha > 0) color = mix(color, s.color, alpha)
      }
      // The arrow: a shaft and two strokes of the head, between the two icons.
      const px = x + 0.5
      const py = y + 0.5
      const arrow = Math.max(
        segmentAlpha(px, py, 215, DMG_ICON_Y, 322, DMG_ICON_Y, 2),
        segmentAlpha(px, py, 322, DMG_ICON_Y, 306, DMG_ICON_Y - 14, 2),
        segmentAlpha(px, py, 322, DMG_ICON_Y, 306, DMG_ICON_Y + 14, 2)
      )
      if (arrow > 0) color = mix(color, accent, arrow)
      const mx = x - markAt.left
      const my = y - markAt.top
      if (mx >= 0 && my >= 0 && mx < mark.size && my < mark.size) {
        const at = (my * mark.size + mx) * 4
        const keep = 1 - mark.rgba[at + 3] / 255
        color = color.map((channel, i) => Math.round(channel * keep + mark.rgba[at + i]))
      }
      return color
    },
    deflate
  )
}
