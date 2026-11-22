/**
 * Why main showed the static page (fallback.html), passed as `?reason=…` so the
 * page can say what really happened. Anything else is read as unknown.
 */
export const FALLBACK_PARAM = 'reason'
export type FallbackReason = 'crashes' | 'load' | 'mount'

const KEEP = ' Агенты в чатах продолжают работать — с ними ничего не случилось.'
export const FALLBACK_TEXT: Record<FallbackReason | 'unknown', string> = {
  crashes: 'Окно трижды перезагрузилось и снова упало.' + KEEP,
  load: 'Окно не удалось загрузить.' + KEEP,
  mount: 'Окно не открылось за 15 секунд.' + KEEP,
  unknown: 'Окно не запускается.' + KEEP
}

export function fallbackTextFor(search: string): string {
  const raw = new URLSearchParams(search).get(FALLBACK_PARAM)
  return raw === 'crashes' || raw === 'load' || raw === 'mount' ? FALLBACK_TEXT[raw] : FALLBACK_TEXT.unknown
}
