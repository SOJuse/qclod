// 1.0.1: vpn — the row at the foot of the sidebar: shield, «VPN», a dot of its state, the delay.
import { Shield } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useVpn, vpnActions, vpnTone, VPN_STATUS_TEXT } from '../../vpn/useVpn'

export function VpnButton({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element | null {
  const vpn = useVpn()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!vpn) return null
  const tone = vpnTone(vpn.status)
  const on = vpn.enabled || vpn.status === 'connecting'
  const toggle = (): void => {
    setBusy(true)
    void (on ? vpnActions.disconnect() : vpnActions.connect()).finally(() => setBusy(false))
    setOpen(false)
  }

  return (
    <div className="vpn-row" ref={ref}>
      {open && (
        <div className="vpn-pop" role="menu" data-testid="vpn-menu">
          <div className="vpn-pop-head">
            <span className={`vpn-dot is-${tone}`} aria-hidden="true" />
            {VPN_STATUS_TEXT[vpn.status]}
            {vpn.status === 'connected' && vpn.latencyMs !== null && <span className="vpn-ms">{vpn.latencyMs} мс</span>}
          </div>
          <div className="vpn-pop-server" data-testid="vpn-server">
            {vpn.configured ? vpn.name || vpn.host : 'Ссылка не задана'}
          </div>
          {vpn.lastError && vpn.status !== 'connected' && <div className="vpn-pop-error">{vpn.lastError}</div>}
          {vpn.configured && (
            <button type="button" role="menuitem" className="vpn-pop-item" data-testid="vpn-toggle" disabled={busy} onClick={toggle}>
              {on ? 'Отключить' : 'Подключить'}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="vpn-pop-item"
            data-testid="vpn-menu-telegram"
            title={`SOCKS5 127.0.0.1:${vpn.socksPort}`}
            onClick={() => {
              setOpen(false)
              void vpnActions.openTelegram().catch(() => undefined)
            }}
          >
            Подключить Telegram
          </button>
          <button
            type="button"
            role="menuitem"
            className="vpn-pop-item"
            data-testid="vpn-settings"
            onClick={() => {
              setOpen(false)
              onOpenSettings()
            }}
          >
            Настройки VPN
          </button>
          {on && <div className="vpn-pop-hint">Применится к новым чатам; «Начать заново» — сразу.</div>}
        </div>
      )}
      <button
        type="button"
        className={`vpn-button${open ? ' is-open' : ''}`}
        data-testid="vpn-button"
        data-status={vpn.status}
        title={`VPN: ${VPN_STATUS_TEXT[vpn.status].toLowerCase()}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Shield size={14} aria-hidden="true" />
        <span>VPN</span>
        <span className={`vpn-dot is-${tone}`} aria-hidden="true" />
        {vpn.status === 'connected' && vpn.latencyMs !== null && (
          <span className="vpn-ms" data-testid="vpn-latency">
            {vpn.latencyMs} мс
          </span>
        )}
        {vpn.status === 'reconnecting' && <span className="vpn-ms">переподключается</span>}
      </button>
    </div>
  )
}
