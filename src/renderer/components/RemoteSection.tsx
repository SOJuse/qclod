import { ExternalLink, Power, Smartphone } from 'lucide-react'
import type { RemoteInfo } from '../../shared/types'
import { REMOTE_BLOCK_TEXT, REMOTE_STATE_LABEL, isRemoteLive, safeRemoteUrl } from '../../shared/remote'
import { ERROR_ICON } from '../ui/icons'
import { QrCode } from './QrCode'
import './RemoteSection.css'

interface Props {
  remote: RemoteInfo
  onToggle: (enabled: boolean) => void
}

/**
 * Remote Control of this tab, in the side panel: off — one line and a button;
 * on — the link as a QR code on a light sheet, the same link as text, and the
 * way to turn it off. The link is shown here and nowhere else.
 */
export function RemoteSection({ remote, onToggle }: Props): JSX.Element {
  const live = isRemoteLive(remote)
  const url = safeRemoteUrl(remote.url)
  const showLink = url !== null && (remote.state === 'on' || remote.state === 'reconnecting')

  return (
    <section className="panel-section remote" data-testid="panel-remote" data-state={remote.state}>
      <h3>Remote Control</h3>

      {remote.state === 'off' ? (
        <p className="remote-lead">Продолжайте эту сессию с телефона или claude.ai.</p>
      ) : (
        <div className="remote-state" data-state={remote.state}>
          <span className="remote-dot" aria-hidden />
          {REMOTE_STATE_LABEL[remote.state]}
        </div>
      )}

      {remote.state === 'connecting' && <p className="remote-lead">Подключаемся к claude.ai…</p>}

      {showLink && (
        <>
          <div className="remote-scan">
            <div className="remote-sheet">
              <QrCode text={url} label="QR-код ссылки на сессию" />
            </div>
            <p className="remote-hint" data-testid="remote-hint">
              Наведите камеру телефона или откройте ссылку на claude.ai.
            </p>
          </div>
          <div className="remote-link" data-testid="remote-link">
            {url}
          </div>
        </>
      )}

      {remote.blocked ? (
        <p className="remote-blocked">{REMOTE_BLOCK_TEXT[remote.blocked]}</p>
      ) : (
        <div className="remote-actions">
          {showLink && (
            <button
              type="button"
              className="remote-button"
              data-testid="remote-open"
              title="Открыть ссылку на сессию в браузере"
              onClick={() => void window.qclod.openExternal(url)}
            >
              <ExternalLink size={13} aria-hidden="true" />
              Открыть в браузере
            </button>
          )}
          {live ? (
            <button
              type="button"
              className="remote-button"
              data-testid="remote-off"
              title="Выключить Remote Control"
              onClick={() => onToggle(false)}
            >
              <Power size={13} aria-hidden="true" />
              Выключить
            </button>
          ) : (
            <button
              type="button"
              className="remote-button is-primary"
              data-testid="remote-on"
              title="Включить Remote Control"
              onClick={() => onToggle(true)}
            >
              <Smartphone size={13} aria-hidden="true" />
              Включить
            </button>
          )}
        </div>
      )}

      {remote.problem && (
        <p className="remote-problem">
          <ERROR_ICON size={13} aria-hidden="true" />
          <span>{remote.problem}</span>
        </p>
      )}

      {live && <p className="panel-note">Закроете вкладку — сессия на телефоне станет недоступна.</p>}
    </section>
  )
}
