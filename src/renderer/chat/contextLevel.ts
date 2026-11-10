/**
 * How full a meter is, in three steps: the context window and the plan's
 * limits share one rule, so the same colour means the same thing everywhere.
 * At 80% it is time to notice; at 90% the next long answer may not fit.
 */
export type ContextLevel = 'ok' | 'warn' | 'critical'

export const WARN_PERCENT = 80
export const CRITICAL_PERCENT = 90

/**
 * Judged on the whole percent a person sees, so «90%» on screen is always
 * critical and «80%» always a warning — never one level below what it says.
 */
export function contextLevel(percent: number): ContextLevel {
  const shown = Math.round(percent)
  if (shown >= CRITICAL_PERCENT) return 'critical'
  if (shown >= WARN_PERCENT) return 'warn'
  return 'ok'
}
