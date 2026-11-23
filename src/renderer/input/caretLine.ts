const MIRRORED = [
  'boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
  'lineHeight', 'textTransform', 'textIndent', 'wordSpacing', 'tabSize', 'whiteSpace',
  'overflowWrap', 'wordBreak', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'
] as const

/** Vertical offset of the caret at `pos` inside a textarea, measured on an invisible copy of it. */
export function caretTop(el: HTMLTextAreaElement, pos: number): number {
  const mirror = document.createElement('div')
  const style = getComputedStyle(el)
  for (const name of MIRRORED) mirror.style[name] = style[name]
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.overflow = 'hidden'
  mirror.style.height = 'auto'
  // A textarea's content box loses the scrollbar's width; the mirror has none.
  mirror.style.width = `${el.clientWidth + (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0)}px`
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.textContent = el.value.slice(0, pos)
  const marker = document.createElement('span')
  marker.textContent = el.value.slice(pos) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop
  mirror.remove()
  return top
}

/** Both caret positions sit on the same visual (wrapped) line of the field. */
export function sameVisualLine(el: HTMLTextAreaElement, a: number, b: number): boolean {
  return caretTop(el, a) === caretTop(el, b)
}
