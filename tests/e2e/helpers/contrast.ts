import type { Page } from '@playwright/test'

export interface ContrastViolation {
  text: string
  ratio: number
  color: string
  background: string
  selector: string
}

/**
 * Every visible piece of text under `root` whose colour does not stand out
 * enough from what is actually behind it: 4.5:1, or 3:1 for large text
 * (≥ 24px, or ≥ 18.66px at weight 600 and up).
 *
 * The background is what the eye sees, not the element's own box: translucent
 * fills (a category chip's tint, a selected row, `color-mix` with transparent)
 * are blended over their ancestors down to the first opaque one; with none,
 * the page body's. Text that is hidden, aria-hidden, disabled or inert is
 * skipped — it is not there to be read.
 */
export async function auditContrast(win: Page, root = 'body'): Promise<ContrastViolation[]> {
  return win.evaluate((rootSelector) => {
    type Rgba = [number, number, number, number]

    // Chromium serialises colours as rgb()/rgba(), and color-mix() as color(srgb r g b / a).
    const parse = (value: string): Rgba | null => {
      const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/)
      if (rgb) {
        const a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4])
        return [parseFloat(rgb[1]!), parseFloat(rgb[2]!), parseFloat(rgb[3]!), a]
      }
      const srgb = value.match(/^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/)
      if (srgb) {
        const a = srgb[4] === undefined ? 1 : srgb[4].endsWith('%') ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4])
        return [parseFloat(srgb[1]!) * 255, parseFloat(srgb[2]!) * 255, parseFloat(srgb[3]!) * 255, a]
      }
      if (value === 'transparent') return [0, 0, 0, 0]
      return null
    }

    // `top` over an opaque `under`.
    const over = (top: Rgba, under: Rgba): Rgba => [
      top[0] * top[3] + under[0] * (1 - top[3]),
      top[1] * top[3] + under[1] * (1 - top[3]),
      top[2] * top[3] + under[2] * (1 - top[3]),
      1
    ]

    const luminance = ([r, g, b]: Rgba): number => {
      const lin = (c: number): number => {
        const s = c / 255
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    const ratioOf = (a: Rgba, b: Rgba): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
      return (hi + 0.05) / (lo + 0.05)
    }

    const show = (c: Rgba): string => `rgb(${c.slice(0, 3).map((v) => Math.round(v)).join(', ')})`

    const backdropOf = (el: Element): Rgba => {
      const layers: Rgba[] = []
      for (let node: Element | null = el; node; node = node.parentElement) {
        const c = parse(getComputedStyle(node).backgroundColor)
        if (c && c[3] > 0) {
          layers.push(c)
          if (c[3] >= 1) break
        }
      }
      let base: Rgba
      if (layers.length > 0 && layers[layers.length - 1]![3] >= 1) base = layers.pop()!
      else base = parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1]
      if (base[3] < 1) base = over(base, [255, 255, 255, 1])
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i]!, base)
      return base
    }

    const hidden = (el: Element): boolean => {
      if (el.closest('[aria-hidden="true"], [inert]')) return true
      if (el.closest('button:disabled, input:disabled, select:disabled, textarea:disabled, fieldset:disabled')) return true
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return true
      const style = getComputedStyle(el)
      if (style.visibility !== 'visible') return true
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (parseFloat(getComputedStyle(node).opacity) === 0) return true
      }
      return false
    }

    const describe = (el: Element): string => {
      const id = el.getAttribute('data-testid')
      const cls = [...el.classList].slice(0, 2).map((c) => '.' + c).join('')
      return el.tagName.toLowerCase() + cls + (id ? `[data-testid="${id}"]` : '')
    }

    const root = document.querySelector(rootSelector)
    if (!root) throw new Error(`auditContrast: nothing matches ${rootSelector}`)

    const found: Array<{ text: string; ratio: number; color: string; background: string; selector: string }> = []
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (el instanceof HTMLScriptElement || el instanceof HTMLStyleElement) continue
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim()
      if (own === '' || hidden(el)) continue

      const style = getComputedStyle(el)
      const ink = parse(style.color)
      if (!ink) continue
      const back = backdropOf(el)
      const fore = ink[3] < 1 ? over(ink, back) : ink
      const ratio = ratioOf(fore, back)

      const size = parseFloat(style.fontSize)
      const large = size >= 24 || (size >= 18.66 && parseInt(style.fontWeight, 10) >= 600)
      if (ratio < (large ? 3 : 4.5)) {
        found.push({
          text: own.slice(0, 60),
          ratio: Math.round(ratio * 100) / 100,
          color: show(fore),
          background: show(back),
          selector: describe(el)
        })
      }
    }
    return found
  }, root)
}
