import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Shared helpers for the static style tests: read tokens.css, resolve and measure colours. */

const RENDERER = resolve(__dirname, '../../src/renderer')
const TOKENS_CSS = join(RENDERER, 'styles', 'tokens.css')

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The `--name: value` pairs declared in the `:root` blocks, in source order. */
export function readTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>()
  const clean = stripComments(css)
  for (const root of clean.matchAll(/:root\s*\{/g)) {
    const start = root.index + root[0].length
    let depth = 1
    let i = start
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === '{') depth++
      else if (clean[i] === '}') depth--
    }
    const body = clean.slice(start, i - 1)
    for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(d[1], d[2].trim())
  }
  return tokens
}

/** Follows `var(--x)` to a plain `#rrggbb`; anything else (color-mix, rgba, a gradient) is an error. */
export function resolveColor(tokens: Map<string, string>, name: string): string {
  const seen = new Set<string>()
  let current = name
  for (;;) {
    if (seen.has(current)) throw new Error(`${name}: var() cycle through ${current}`)
    seen.add(current)
    const value = tokens.get(current)
    if (value === undefined) throw new Error(`${name}: token ${current} is not declared in :root`)
    const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value)
    if (ref) {
      current = ref[1]
      continue
    }
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
    if (!hex) throw new Error(`${name}: ${current} is «${value}», not an opaque #rrggbb colour`)
    const h = hex[1].toLowerCase()
    return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h)
  }
}

function srgb(hex: string): [number, number, number] {
  const h = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!h) throw new Error(`not a #rrggbb colour: ${hex}`)
  const n = parseInt(h[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as [number, number, number]
}

function linear(hex: string): [number, number, number] {
  return srgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
}

function luminance(hex: string): number {
  const [r, g, b] = linear(hex)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** `color-mix(in srgb, a pct%, b)` for two opaque colours: each sRGB channel weighted, rounded to a byte. */
export function mix(a: string, b: string, pct: number): string {
  const [x, y] = [srgb(a), srgb(b)]
  const p = pct / 100
  return '#' + x.map((c, i) => Math.round((c * p + y[i] * (1 - p)) * 255).toString(16).padStart(2, '0')).join('')
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function oklab(hex: string): [number, number, number] {
  const [r, g, b] = linear(hex)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

/** Euclidean distance in OKLab × 100, as dataviz's validate_palette.js measures it. */
export function deltaE(a: string, b: string): number {
  const [x, y] = [oklab(a), oklab(b)]
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return walk(p, ext)
    return e.name.endsWith(ext) ? [p] : []
  })
}

/** Every renderer stylesheet except tokens.css itself, as absolute paths. */
export function rendererCssFiles(): string[] {
  return walk(RENDERER, '.css').filter((p) => resolve(p) !== TOKENS_CSS)
}

/** Every renderer component file, as absolute paths. */
export function rendererTsxFiles(): string[] {
  return walk(RENDERER, '.tsx')
}

export interface CssRule {
  file: string
  selector: string
  body: string
}

function parseRules(file: string, css: string, out: CssRule[]): void {
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) return
    let depth = 1
    let j = open + 1
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
    }
    const head = css.slice(i, open).trim()
    const body = css.slice(open + 1, j - 1)
    if (head.startsWith('@')) {
      // @media / @supports wrap more rules; @font-face and @keyframes hold declarations or frames, not selectors.
      if (/^@(media|supports|layer)\b/.test(head)) parseRules(file, body, out)
    } else {
      for (const selector of head.split(',')) out.push({ file, selector: selector.trim(), body })
    }
    i = j
  }
}

/** Every style rule of the renderer stylesheets, tokens.css included; one entry per selector of a comma list, @media unwrapped. */
export function cssRules(): CssRule[] {
  const out: CssRule[] = []
  for (const f of walk(RENDERER, '.css')) parseRules(f, stripComments(readFileSync(f, 'utf8')), out)
  return out
}
