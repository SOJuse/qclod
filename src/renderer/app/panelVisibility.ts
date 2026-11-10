/**
 * Whether the side panel shows.
 *
 * Below this width the panel would squeeze the conversation, so it folds by
 * itself; what it held that matters while typing — context, limits, model,
 * effort, mode — is in the status line by the input anyway.
 */
export const PANEL_MIN_WIDTH = 1100

/** A choice made with the panel button for this window, not saved anywhere. */
export type PanelOverride = 'open' | 'closed' | null

export function panelVisible({
  setting,
  width,
  override
}: {
  setting: boolean
  width: number
  override: PanelOverride
}): boolean {
  if (override === 'open') return true
  if (override === 'closed') return false
  return setting && width >= PANEL_MIN_WIDTH
}

/**
 * The override after the window changed width. Crossing the threshold
 * forgets it: the window is a different shape now, and the rule applies again.
 */
export function nextOverride(override: PanelOverride, before: number, after: number): PanelOverride {
  const wasWide = before >= PANEL_MIN_WIDTH
  const isWide = after >= PANEL_MIN_WIDTH
  return wasWide === isWide ? override : null
}
