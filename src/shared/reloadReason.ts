/**
 * How the window learns that the watchdog reloaded it after a hang (task 9b):
 * main loads the page with `?reloaded=hang` (main/window.ts watchRenderer,
 * main/index.ts loadRenderer). The page then holds back a long draft instead
 * of putting it straight into the field, where it may freeze the page again.
 */
export const RELOAD_PARAM = 'reloaded'
export const AFTER_HANG = 'hang'

export function isAfterHang(search: string): boolean {
  return new URLSearchParams(search).get(RELOAD_PARAM) === AFTER_HANG
}
