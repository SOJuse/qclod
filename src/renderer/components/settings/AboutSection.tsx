import { Group } from './parts'
import type { SettingsSectionProps } from './types'

export function AboutSection({ version }: SettingsSectionProps): JSX.Element {
  return (
    <Group>
      <p className="settings-version">{version ? `Qclod ${version}` : 'Qclod'} · обновления ставятся вручную</p>
      <button
        type="button"
        className="btn btn-sm settings-about-button"
        data-testid="open-logs"
        onClick={() => {
          window.qclod.openLogs().catch(() => undefined)
        }}
      >
        Открыть журнал
      </button>
    </Group>
  )
}
