/** Small Russian-language formatters shared by the ribbon and the window. */

/** 1 файл, 2 файла, 5 файлов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const tens = n % 100
  const ones = n % 10
  if (tens >= 11 && tens <= 14) return many
  if (ones === 1) return one
  if (ones >= 2 && ones <= 4) return few
  return many
}

/** 1 строка, 3 строки, 10 строк. */
export function lines(n: number): string {
  return `${n} ${plural(n, 'строка', 'строки', 'строк')}`
}

function decimal(value: number): string {
  return value.toFixed(1).replace('.', ',')
}

/** «1,2 с», «42 с», «3 мин 20 с». */
export function seconds(ms: number): string {
  if (ms < 9_950) return `${decimal(Math.max(0, ms) / 1000)} с`
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} с`
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`
}

/** 15000 → «15k»: the magnitude is what matters, not the digits. */
export function compactNumber(n: number): string {
  const short = (value: number, suffix: string): string => {
    const text = value < 10 ? decimal(value) : String(Math.round(value))
    return `${text.replace(/,0$/, '')}${suffix}`
  }
  if (n < 1000) return String(n)
  // 999 999 rounds to 1000k: it is already a million.
  if (Math.round(n / 1000) < 1000) return short(n / 1000, 'k')
  return short(n / 1_000_000, 'M')
}

/** «300 Б», «12 КБ», «1,4 МБ». */
export function bytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} Б`
  if (Math.round(n / 1024) < 1024) return `${Math.round(n / 1024)} КБ`
  return `${decimal(n / (1024 * 1024))} МБ`
}

/** The first line of a text, cut to `max` characters with an ellipsis. */
export function clip(text: string, max = 80): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * A moment as the person's own clock shows it — Windows' time zone, which
 * Chromium reads from the system: «14:35:07» today, «16 нояб., 14:35» another day.
 */
export function clockTime(ms: number, nowMs = Date.now(), withSeconds = true): string {
  const at = new Date(ms)
  const now = new Date(nowMs)
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  const time = at.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds && sameDay ? { second: '2-digit' } : {})
  })
  if (sameDay) return time
  const day = at.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' })
  })
  return `${day}, ${time}`
}

/**
 * When a past conversation was last touched, as short as a list row allows:
 * «14:05» today, «вчера», «12 нояб.» this year, «12.11.2025» before it.
 */
export function shortWhen(ms: number, nowMs = Date.now()): string {
  const at = new Date(ms)
  const now = new Date(nowMs)
  const sameDay = (a: Date, b: Date): boolean =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(at, now)) return at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  if (sameDay(at, yesterday)) return 'вчера'
  if (at.getFullYear() === now.getFullYear()) return at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  return at.toLocaleDateString('ru-RU')
}

/** «через 2 ч 15 мин», from a unix timestamp in seconds: when a plan limit resets. */
export function untilReset(resetsAt: number, nowMs = Date.now()): string {
  const minutes = Math.max(0, Math.round((resetsAt * 1000 - nowMs) / 60000))
  if (minutes < 60) return `через ${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `через ${hours} ч ${minutes % 60} мин`
  return `через ${Math.round(hours / 24)} дн`
}
