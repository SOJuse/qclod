import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Focus for the modal sheets (settings, history, Ctrl+K): Tab stays inside the
 * sheet, and closing it puts focus back on whatever opened it — the button or
 * the input — instead of dropping it on `body`, where the ring is lost.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

type FocusTarget = Pick<HTMLElement, 'focus'> & { isConnected: boolean }

/**
 * Notes what has focus now; the returned function gives it back. If that
 * element is gone, refuses focus (disabled meanwhile, like the input of a dead
 * session), or focus was nowhere, `fallback` decides where it goes.
 */
export function rememberFocus(
  doc: { activeElement: Element | null; body: HTMLElement }
): (fallback?: () => void) => void {
  const opener = doc.activeElement === doc.body ? null : (doc.activeElement as FocusTarget | null)
  return (fallback) => {
    if (opener && opener.isConnected) {
      opener.focus()
      if (doc.activeElement === (opener as unknown as Element)) return
    }
    fallback?.()
  }
}

/** Where Tab should go so focus never leaves the sheet; null lets the browser move it. */
export function trapStep<T>(items: readonly T[], active: T | null, back: boolean): T | null {
  if (items.length === 0) return null
  const at = active === null ? -1 : items.indexOf(active)
  const first = items[0]!
  const last = items[items.length - 1]!
  if (at === -1) return back ? last : first
  if (!back && at === items.length - 1) return first
  if (back && at === 0) return last
  return null
}

type KeyLike = { key: string; shiftKey: boolean; preventDefault: () => void }
type Focusable = Pick<HTMLElement, 'focus' | 'getClientRects'>

/** Keeps a Tab press inside `sheet`: wraps at either end, holds still when there is nothing to reach. */
export function trapTab(
  sheet: { querySelectorAll: (selector: string) => NodeListOf<HTMLElement> },
  ev: KeyLike,
  active: Element | null
): void {
  if (ev.key !== 'Tab') return
  const items: Focusable[] = [...sheet.querySelectorAll(FOCUSABLE)].filter(
    (el: Focusable) => el.getClientRects().length > 0
  )
  if (items.length === 0) {
    ev.preventDefault()
    return
  }
  const target = trapStep(items, active as Focusable | null, ev.shiftKey)
  if (!target) return
  ev.preventDefault()
  target.focus()
}

/**
 * For a modal sheet: remembers the opener on the first render (before the
 * sheet moves focus into itself) and gives focus back when the sheet unmounts.
 * `onFocusLost` runs when the opener is gone. Returns the sheet's Tab trap,
 * for its onKeyDown.
 */
export function useModalFocus(
  sheet: RefObject<HTMLElement>,
  onFocusLost?: () => void
): (ev: React.KeyboardEvent) => void {
  // Drawn to markup (no document, as in the markup tests) there is nothing to give back.
  const [restore] = useState(() =>
    typeof document === 'undefined' ? (_fallback?: () => void) => undefined : rememberFocus(document)
  )
  const lost = useRef(onFocusLost)
  lost.current = onFocusLost
  useEffect(() => () => restore(lost.current), [restore])
  return useCallback(
    (ev: React.KeyboardEvent) => {
      if (sheet.current) trapTab(sheet.current, ev, document.activeElement)
    },
    [sheet]
  )
}

/**
 * Where a modal sheet puts focus when it opens or changes step: the control
 * marked `data-autofocus`, else the first one of its body, else the sheet
 * itself (it carries tabIndex -1). Focus inside is what keeps Enter and Esc
 * from the input line behind it, where they would send or stop the agent.
 */
export function focusInto(sheet: HTMLElement | null): void {
  if (!sheet) return
  const marked = sheet.querySelector<HTMLElement>('[data-autofocus]:not([disabled])')
  const body = sheet.querySelector<HTMLElement>('.sheet-body') ?? sheet
  const first = [...body.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => !el.hasAttribute('disabled'))
  ;(marked ?? first ?? sheet).focus()
}

/**
 * A modal sheet's keys (stage 6, R2): Esc closes or cancels it and goes no
 * further — not to the input line, not to the window — and Tab stays inside
 * (useModalFocus). For the sheet's onKeyDown.
 */
export function useModalSheet(
  sheet: RefObject<HTMLElement>,
  onEscape: () => void,
  onFocusLost?: () => void
): (ev: React.KeyboardEvent) => void {
  const trap = useModalFocus(sheet, onFocusLost)
  const escape = useRef(onEscape)
  escape.current = onEscape
  return useCallback(
    (ev: React.KeyboardEvent) => {
      if (ev.key !== 'Escape') return trap(ev)
      if (ev.nativeEvent.isComposing) return
      ev.preventDefault()
      ev.stopPropagation()
      escape.current()
    },
    [trap]
  )
}
