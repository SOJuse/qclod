/** What Qclod sends to carry on by itself (decision 12). */
export const CONTINUE_TEXT = 'продолжай'

/**
 * The core's clock timer never reaches further than this (decision 15): a
 * sleep with no `resume` event moves a deadline by at most a minute.
 */
export const TICK_MAX_MS = 60_000

/** More crashes than CRASH_MAX inside this window and Qclod stops restarting by itself. */
export const CRASH_WINDOW_MS = 10 * 60_000
export const CRASH_MAX = 3
/** «Продолжай» after a limit, in a row without the person; the next limit is the end of it. */
export const LIMIT_CONTINUES_MAX = 3
/** Spread after a limit reset, so that every tab does not go at the same second. */
export const LIMIT_JITTER_MS = 120_000
/** When the reset time is unknown (decision 7). */
export const LIMIT_FALLBACK_MS = 30 * 60_000
/** A dropped Remote Control bridge is asked again this often, this many times (decision 9). */
export const REMOTE_RETRY_MS = 60_000
export const REMOTE_RETRY_MAX = 3
/** After waking the CLI reconnects by itself; the bridge is checked only this long after. */
export const REMOTE_RESUME_CHECK_MS = 30_000
