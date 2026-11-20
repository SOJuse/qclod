/**
 * How a chat pane shows its own right-hand panel (spec E5: each half of a
 * split has its own).
 *
 * Below this width of the pane the panel would squeeze the conversation, so
 * it folds by itself; opened by hand there, it slides out over the ribbon
 * instead of taking room. What matters while typing — context, model,
 * effort, mode, a limit near its end — is in the status line anyway.
 */
export const PANE_PANEL_MIN_WIDTH = 760

/** A choice made with the panel button for this pane, not saved anywhere. */
export type PanelOverride = 'open' | 'closed' | null

export type PanelMode = 'docked' | 'drawer' | 'hidden'

export function panelMode({
  setting,
  paneWidth,
  override
}: {
  setting: boolean
  paneWidth: number
  override: PanelOverride
}): PanelMode {
  const wide = paneWidth >= PANE_PANEL_MIN_WIDTH
  if (override === 'closed') return 'hidden'
  if (override === 'open') return wide ? 'docked' : 'drawer'
  return setting && wide ? 'docked' : 'hidden'
}

/**
 * The override after the pane changed width. Crossing the threshold
 * forgets it: the pane is a different shape now, and the rule applies again.
 */
export function nextOverride(override: PanelOverride, before: number, after: number): PanelOverride {
  const wasWide = before >= PANE_PANEL_MIN_WIDTH
  const isWide = after >= PANE_PANEL_MIN_WIDTH
  return wasWide === isWide ? override : null
}
