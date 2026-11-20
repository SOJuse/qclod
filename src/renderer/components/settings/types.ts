import type { AppSettings, ModelOption } from '../../../shared/types'

/** What the screen hands to every section. A refused save rejects `patch`; the screen shows the reason itself. */
export interface SettingsSectionProps {
  settings: AppSettings
  patch(p: Partial<AppSettings>): Promise<AppSettings>
  /** Models the active tab's session offers; empty until it has started. */
  models: ModelOption[]
  version: string
  /** A field to start in, selected: the setup screen opens settings for the agent path. */
  focusField?: 'agentPath'
}

/**
 * One section of the settings screen. A new section is a new file with a component
 * and one line in `registry.ts`; `order` goes in steps of 10 so a section can land between two.
 */
export interface SettingsSectionDef {
  id: string
  title: string
  order: number
  Component(props: SettingsSectionProps): JSX.Element
}
