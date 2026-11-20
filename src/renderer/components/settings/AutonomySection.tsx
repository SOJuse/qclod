import { Field, Group, save, Toggle } from './parts'
import type { SettingsSectionProps } from './types'

/** «Не спать», as it holds on Windows: Modern Standby and the power button still win. */
export const KEEP_AWAKE_WINDOWS =
  'Пока агент работает, ждёт вашего ответа или сброса лимита, Qclod не даёт компьютеру уснуть. ' +
  'Закрытая крышка ноутбука, кнопка питания и «Сон» в меню «Пуск» всё равно его усыпят — ' +
  'тогда работа и Remote Control встанут до пробуждения.'

/** The same on a Mac, where only the lid still wins. */
export const KEEP_AWAKE_MAC =
  'Пока агент работает, ждёт вашего ответа или сброса лимита, Qclod не даёт компьютеру уснуть. ' +
  'Закрытая крышка MacBook всё равно его усыпит — тогда работа и Remote Control встанут до пробуждения.'

/** Which «не спать» paragraph this machine gets, by the window's user agent. */
export function keepAwakeText(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  return /Macintosh|Mac OS X/.test(userAgent) ? KEEP_AWAKE_MAC : KEEP_AWAKE_WINDOWS
}

/**
 * Whether this is an installed Qclod: its page is served from inside
 * `resources/app.asar`. A dev server or an unpacked build is not, and main
 * registers no login item for it (`app.isPackaged`, task 10).
 */
export function installedBuild(href: string = typeof window === 'undefined' ? '' : window.location.href): boolean {
  return /\/app\.asar\//.test(href)
}

/** Whole minutes 1…60, or null: anything else is not sent (main checks again). */
export function minutesFrom(raw: string): number | null {
  const text = raw.trim()
  if (text === '') return null
  const n = Number(text)
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : null
}

/** «Автономность»: how long «авто-да» waits before answering, starting with Windows, staying awake. */
export function AutonomySection({ settings, patch }: SettingsSectionProps): JSX.Element {
  const installed = installedBuild()
  return (
    <Group>
      <Field label="Отвечать за меня через">
        <span className="settings-minutes">
          <input
            type="number"
            className="field"
            data-testid="setting-autoAnswerMinutes"
            min={1}
            max={60}
            step={1}
            defaultValue={settings.autoAnswerMinutes}
            onBlur={(e) => {
              const minutes = minutesFrom(e.target.value)
              // A value out of range goes back to the one in force rather than being sent.
              if (minutes === null) e.target.value = String(settings.autoAnswerMinutes)
              else save(patch, { autoAnswerMinutes: minutes })
            }}
          />
          <span>мин</span>
        </span>
      </Field>
      <p className="settings-hint">
        Только в режиме «авто-да»: если на вопрос или план никто не ответил, Qclod выберет рекомендуемый
        вариант (или первый) и одобрит план.
      </p>
      <Toggle
        id="openAtLogin"
        label="Запускать Qclod при входе в систему"
        checked={settings.openAtLogin}
        disabled={!installed}
        onChange={(openAtLogin) => save(patch, { openAtLogin })}
      />
      <p className="settings-hint">
        Вкладки откроются сами, Remote Control включится снова, а прерванная работа продолжится.
      </p>
      {!installed && (
        <p className="settings-hint" data-testid="openAtLogin-dev">
          Работает только в установленном Qclod.
        </p>
      )}
      <p className="settings-hint" data-testid="keep-awake">
        {keepAwakeText()}
      </p>
    </Group>
  )
}
