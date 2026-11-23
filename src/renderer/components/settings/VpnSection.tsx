// 1.0.1: vpn — «VPN» in the settings: the link (kept sealed in main), auto-connect, the sites, the state.
import { useEffect, useState } from 'react'
import { reasonOf } from '../../ui/StateView'
import { useVpn, vpnActions, VPN_STATUS_TEXT } from '../../vpn/useVpn'
import { Field, Group, Toggle } from './parts'
import './VpnSection.css'

export function VpnSection(): JSX.Element {
  const vpn = useVpn()
  const [link, setLink] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const [sites, setSites] = useState('')
  const [sitesDirty, setSitesDirty] = useState(false)

  useEffect(() => {
    if (vpn && !sitesDirty) setSites(vpn.sites.join('\n'))
  }, [vpn, sitesDirty])

  if (!vpn) return <Group>Загрузка…</Group>

  const saveLink = (): void => {
    setLinkError(null)
    vpnActions.setLink(link).then(
      () => setLink(''),
      (e) => setLinkError(reasonOf(e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    )
  }
  const saveSites = (): void => {
    void vpnActions.setOptions({ sites }).then(() => setSitesDirty(false))
  }
  const on = vpn.enabled || vpn.status === 'connecting'

  return (
    <>
      <Group>
        <p className="settings-hint">
          Hysteria2 только для Claude Code (локальные чаты) и сайтов из списка. Сам Qclod и серверные чаты идут напрямую.
        </p>
        <Field label="Ссылка hysteria2://">
          <input
            type="password"
            className="field"
            data-testid="vpn-link"
            autoComplete="off"
            spellCheck={false}
            placeholder={vpn.configured ? `Сохранена: ${vpn.host}${vpn.name ? ` (${vpn.name})` : ''}` : 'Вставьте ссылку'}
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && link.trim()) saveLink()
            }}
          />
        </Field>
        <div className="vpn-actions">
          <button type="button" className="btn btn-primary btn-sm" data-testid="vpn-link-save" disabled={!link.trim()} onClick={saveLink}>
            Сохранить
          </button>
          {vpn.configured && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="vpn-link-forget"
              onClick={() => void vpnActions.setLink('')}
            >
              Забыть ссылку
            </button>
          )}
        </div>
        {linkError && (
          <p className="settings-warning" data-testid="vpn-link-error">
            {linkError}
          </p>
        )}
        {!vpn.canStore && <p className="settings-warning">Система не даёт зашифровать ссылку — сохранить её нельзя.</p>}
        <Toggle
          id="vpnAutoConnect"
          label="Подключаться при запуске"
          checked={vpn.autoConnect}
          onChange={(autoConnect) => void vpnActions.setOptions({ autoConnect })}
        />
      </Group>
      <Group title="Состояние">
        <p data-testid="vpn-state">
          {VPN_STATUS_TEXT[vpn.status]}
          {vpn.status === 'connected' && vpn.latencyMs !== null ? ` · ${vpn.latencyMs} мс` : ''}
        </p>
        {vpn.lastError && (
          <p className="settings-warning" data-testid="vpn-error">
            {vpn.lastError}
          </p>
        )}
        <div className="vpn-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="vpn-section-toggle"
            disabled={!vpn.configured}
            onClick={() => void (on ? vpnActions.disconnect() : vpnActions.connect())}
          >
            {on ? 'Отключить' : 'Подключить'}
          </button>
        </div>
        <p className="settings-hint">Применится к новым чатам; «Начать заново» — сразу.</p>
      </Group>
      <Group title="Telegram">
        <p data-testid="vpn-telegram-addr">SOCKS5 127.0.0.1:{vpn.socksPort}</p>
        <div className="vpn-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            data-testid="vpn-telegram-connect"
            onClick={() => void vpnActions.openTelegram().catch(() => undefined)}
          >
            Подключить Telegram
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="vpn-telegram-copy"
            onClick={() => void navigator.clipboard.writeText(`127.0.0.1:${vpn.socksPort}`).catch(() => undefined)}
          >
            Скопировать
          </button>
        </div>
        <p className="settings-hint">Telegram будет ходить через VPN, пока Qclod запущен и VPN подключён.</p>
      </Group>
      <Group title="Сайты через VPN">
        <p className="settings-hint">
          По домену в строке, поддомены тоже. Остальное — напрямую.
          {window.qclod.platform !== 'win32' ? ' На Mac сайты через VPN — в следующей версии.' : ''}
        </p>
        <textarea
          className="field vpn-sites"
          data-testid="vpn-sites"
          rows={10}
          spellCheck={false}
          value={sites}
          onChange={(e) => {
            setSites(e.target.value)
            setSitesDirty(true)
          }}
          onBlur={() => sitesDirty && saveSites()}
        />
        <div className="vpn-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            data-testid="vpn-sites-defaults"
            onClick={() => {
              setSitesDirty(false)
              void vpnActions.setOptions({ sites: 'defaults' })
            }}
          >
            Вернуть заготовки
          </button>
        </div>
      </Group>
    </>
  )
}
