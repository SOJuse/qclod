/** What Qclod sends to carry on by itself (decision 12). */
export const CONTINUE_TEXT = 'продолжай'

/**
 * The core's clock timer never reaches further than this (decision 15): a
 * sleep with no `resume` event moves a deadline by at most a minute.
 */
export const TICK_MAX_MS = 60_000
