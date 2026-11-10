// Pure drawing helpers for the NSIS wizard artwork (sidebar and header BMPs).
// Motif: the Qclod ribbon - chat-like bars of different lengths, one in the
// accent colour, and the app mark (rounded square) like on the icon.

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
function paint(width, height, shapes) {
  const bg = hex(GRAPHITE.bg)
  return encodeBmp24(width, height, (x, y) => {
    let color = bg
    for (const s of shapes) {
      const alpha = roundedRectAlpha(x + 0.5, y + 0.5, s.left, s.top, s.right, s.bottom, s.radius)
      if (alpha > 0) color = mix(color, s.color, alpha)
    }
    return color
  })
}

function bar(left, top, width, height, color) {
  return { left, top, right: left + width, bottom: top + height, radius: height / 2 > 3 ? 3 : height / 2, color }
}

export function drawSidebar(accent) {
  const widths = [96, 120, 72, 108, 56]
  const neutral = [hex(GRAPHITE.raised), hex(GRAPHITE.line)]
  const bottom = 280
  const shapes = [{ left: 20, top: 20, right: 48, bottom: 48, radius: 7, color: accent }]
  widths.forEach((w, i) => {
    const top = bottom - 6 - (widths.length - 1 - i) * 14
    shapes.push(bar(20, top, w, 6, i === 2 ? accent : neutral[i % 2]))
  })
  return paint(164, 314, shapes)
}

export function drawHeader(accent) {
  const neutral = [hex(GRAPHITE.raised), hex(GRAPHITE.line)]
  const shapes = [{ left: 10, top: 18, right: 30, bottom: 38, radius: 5, color: accent }]
  const widths = [64, 44, 54]
  widths.forEach((w, i) => {
    shapes.push(bar(42, 15 + i * 11, w, 5, i === 1 ? accent : neutral[i % 2]))
  })
  return paint(150, 57, shapes)
}
