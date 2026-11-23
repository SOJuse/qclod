// 1.0.1: vpn — the window's copy of the VPN's state: one subscription, shared.
import { useEffect, useState } from 'react'
import type { VpnStatus, VpnView } from '../../shared/vpn'

let current: VpnView | null = null
const listeners = new Set<(v: VpnView) => void>()
let subscribed = false

function set(v: VpnView): void {
  current = v
  listeners.forEach((cb) => cb(v))
}

function ensure(): void {
  if (subscribed) return
  subscribed = true
  window.qclod.vpn.onChanged(set)
  void window.qclod.vpn.get().then(set, () => undefined)
}

export function useVpn(): VpnView | null {
  const [v, setV] = useState<VpnView | null>(current)
  useEffect(() => {
    ensure()
    listeners.add(setV)
    if (current) setV(current)
    return () => {
      listeners.delete(setV)
    }
  }, [])
  return v
}

/** Calls that answer with a fresh view update everyone at once. */
export const vpnActions = {
  connect: () => window.qclod.vpn.connect().then(set),
  disconnect: () => window.qclod.vpn.disconnect().then(set),
  setLink: (link: string) => window.qclod.vpn.setLink(link).then(set),
  setOptions: (o: { autoConnect?: boolean; sites?: string | 'defaults' }) => window.qclod.vpn.setOptions(o).then(set)
}

export const VPN_STATUS_TEXT: Record<VpnStatus, string> = {
  off: 'Выключен',
  connecting: 'Подключается',
  connected: 'Подключён',
  reconnecting: 'Переподключается',
  error: 'Ошибка'
}

export function vpnTone(s: VpnStatus): 'ok' | 'warn' | 'off' | 'critical' {
  return s === 'connected' ? 'ok' : s === 'connecting' || s === 'reconnecting' ? 'warn' : s === 'error' ? 'critical' : 'off'
}
