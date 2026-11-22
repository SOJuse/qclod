import { useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { ERROR_ICON } from '../ui/icons'
import { reasonOf, StateView } from '../ui/StateView'
import type { AppSettings, ModelOption } from '../../shared/types'
import { useModalFocus } from '../ui/modalFocus'
import { sortedSections } from './settings/registry'
import './SettingsScreen.css'

interface Props {
  /** `null` until the main process has answered; the sheet opens anyway and says it is loading. */
  settings: AppSettings | null
  /** Why the settings could not be read; `onRetryLoad` asks again. */
  loadError?: string | null
  onRetryLoad?: () => void
  version: string
  /** Models the active tab's session offers; empty until it has started. */
  models: ModelOption[]
  onPatch: (patch: Partial<AppSettings>) => Promise<AppSettings>
  onClose: () => void
  /** Closing gives focus back to the opener; this runs when the opener is gone. */
  onFocusLost?: () => void
  /** A field to start in, selected: the setup screen opens settings for the agent path. */
  focusField?: 'agentPath'
  /** The section to open on (`SettingsSectionDef.id`), when it is in the list. */
  initialSection?: string
}

/**
 * The sheet: sections on the left, the open one on the right. What the sections are
 * lives in `settings/registry.ts`; this file knows only how to lay them out and how
 * to show what became of a save.
 */
export function SettingsScreen({
  settings,
  loadError = null,
  onRetryLoad,
  version,
  models,
  onPatch: save,
  onClose,
  onFocusLost,
  focusField,
  initialSection
}: Props): JSX.Element {
  const sections = sortedSections()
  const [active, setActive] = useState(() =>
    focusField === 'agentPath'
      ? 'agent'
      : (sections.find((s) => s.id === initialSection) ?? sections[0])?.id
  )
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout>>()
  const sheet = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const trap = useModalFocus(sheet, onFocusLost)

  /** A «Повторить» goes with its error; focus stays in the sheet rather than falling to the page. */
  const retry = (run: () => void) => (): void => {
    closeButton.current?.focus()
    run()
  }

  useEffect(() => {
    // Focus inside the sheet is what lets Esc reach it. It lands on a control, not
    // on the sheet itself, so the ring shows where Tab goes from here. A field that
    // asked for focus keeps it; it is inside the sheet, so Esc still works.
    if (!focusField) closeButton.current?.focus()
    return () => clearTimeout(savedTimer.current)
  }, [])

  // The indicator follows the answer, not the click: it shows what the main process kept.
  // A refusal stays in its place until a later change is kept. The sections get the answer
  // too (a refused save rejects), so one that wants to can react.
  const patch = (change: Partial<AppSettings>): Promise<AppSettings> => {
    const done = save(change)
    done.then(
      () => {
        setSaveError(null)
        setSaved(true)
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 2000)
      },
      (err) => {
        clearTimeout(savedTimer.current)
        setSaved(false)
        setSaveError(reasonOf(err))
      }
    )
    return done
  }

  // Blurring first lets a field that is still being edited save before the screen goes.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape') return trap(e)
    e.stopPropagation()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    onClose()
  }

  const current = sections.find((section) => section.id === active) ?? sections[0]

  return (
    <div className="sheet-backdrop settings-backdrop" data-testid="settings" onMouseDown={onClose}>
      <section
        className="sheet settings"
        ref={sheet}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Настройки"
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 className="sheet-title">Настройки</h2>
          <div className="settings-head-end">
            {saveError !== null ? (
              <span className="settings-saved is-failed" data-testid="settings-save-failed" role="alert">
                <ERROR_ICON size={14} aria-hidden="true" />
                Не сохранилось: {saveError}
              </span>
            ) : (
              saved && (
                <span className="settings-saved" data-testid="settings-saved" role="status">
                  <Check size={14} aria-hidden="true" />
                  Сохранено
                </span>
              )
            )}
            <button
              ref={closeButton}
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="close-settings"
              aria-label="Закрыть настройки"
              title="Закрыть настройки"
              onClick={onClose}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        {settings === null ? (
          <div className="sheet-body">
            {loadError !== null ? (
              <StateView
                kind="error"
                title="Не удалось прочитать настройки"
                hint={loadError}
                {...(onRetryLoad ? { action: { label: 'Повторить', onClick: retry(onRetryLoad) } } : {})}
              />
            ) : (
              <StateView kind="loading" title="Загружаю настройки…" />
            )}
          </div>
        ) : (
          <div className="settings-layout">
            <nav className="settings-nav" aria-label="Разделы настроек">
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="settings-nav-item"
                  data-testid={`settings-nav-${section.id}`}
                  aria-current={section.id === current?.id ? 'page' : undefined}
                  onClick={() => setActive(section.id)}
                >
                  {section.title}
                </button>
              ))}
            </nav>
            <div className="sheet-body settings-section" data-testid={`settings-section-${current?.id}`}>
              {current && (
                <current.Component
                  key={current.id}
                  settings={settings}
                  patch={patch}
                  models={models}
                  version={version}
                  focusField={focusField}
                />
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
