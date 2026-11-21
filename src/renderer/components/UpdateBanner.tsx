import { Download } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionStatus, UpdateState } from '../../shared/types'
import { useAppStore } from '../state/useAppStore'
import './UpdateBanner.css'

const WORKING_TEXT = 'Во вкладках идёт работа — перезапуск её прервёт.'

/**
 * What to say before a restart cuts work short: an agent mid-answer
 * ('busy') or one waiting for the person ('waiting') is lost by a restart.
 */
export function restartWarning(statuses: SessionStatus[]): string | null {
  return statuses.some((s) => s === 'busy' || s === 'waiting') ? WORKING_TEXT : null
}

/** «Позже» lasts for this run of the app, a reloaded window included. */
const LATER_KEY = 'qclod.updateLater'

function laterFor(version: string): boolean {
  try {
    return sessionStorage.getItem(LATER_KEY) === version
  } catch {
    return false
  }
}

/**
 * A strip under the title bar once a new version is downloaded. «Перезапустить»
 * installs it now; «Позже» hides the strip, and the update still installs
 * when the app quits.
 */
export function UpdateBanner(): JSX.Element | null {
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' })
  const [hidden, setHidden] = useState(false)
  const tabs = useAppStore((s) => s.tabs)
  const warning = useMemo(() => restartWarning(tabs.map((t) => t.status)), [tabs])

  useEffect(() => {
    let live = true
    void window.qclod.getUpdate().then((s) => {
      if (live) setUpdate(s)
    })
    const off = window.qclod.onUpdateChanged(setUpdate)
    return () => {
      live = false
      off()
    }
  }, [])

  if (update.kind === 'idle' || hidden || laterFor(update.version)) return null

  const later = (): void => {
    try {
      sessionStorage.setItem(LATER_KEY, update.version)
    } catch {
      // Without storage the strip still hides until the window reloads.
    }
    setHidden(true)
  }

  // A Mac build does not update itself: a link to the release page instead of a restart.
  if (update.kind === 'available') {
    const { url, version } = update
    return (
      <div className="update-banner" role="status" data-testid="update-banner">
        <span className="update-banner-icon" aria-hidden="true">
          <Download size={14} />
        </span>
        <div className="update-banner-text">
          <p className="update-banner-line">Вышла версия {version}.</p>
        </div>
        <div className="update-banner-actions">
          <button
            type="button"
            className="update-banner-button is-primary"
            data-testid="update-download"
            onClick={() => void window.qclod.openExternal(url)}
          >
            Скачать
          </button>
          <button type="button" className="update-banner-button" data-testid="update-later" onClick={later}>
            Позже
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="update-banner" role="status" data-testid="update-banner">
      <span className="update-banner-icon" aria-hidden="true">
        <Download size={14} />
      </span>
      <div className="update-banner-text">
        <p className="update-banner-line">
          Скачана новая версия {update.version}. Перезапустите Qclod, чтобы обновиться.
        </p>
        {warning && (
          <p className="update-banner-warning" data-testid="update-warning">
            {warning}
          </p>
        )}
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="update-banner-button is-primary"
          data-testid="update-restart"
          onClick={() => void window.qclod.restartToUpdate()}
        >
          Перезапустить
        </button>
        <button
          type="button"
          className="update-banner-button"
          data-testid="update-later"
          onClick={later}
        >
          Позже
        </button>
      </div>
    </div>
  )
}
