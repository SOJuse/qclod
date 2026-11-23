// 1.0.1: vpn — vpn.json in userData. The link is kept sealed by the OS (safeStorage), never in the clear.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_VPN_SITES, parseSites } from '../../shared/vpn'
import type { SavedProxy } from './systemProxy'

export const VPN_FILE = 'vpn.json'

export interface VpnRecord {
  sealedLink: string | null
  autoConnect: boolean
  sites: string[]
  /** Our system PAC is set: what the user had before (restored on off/exit/next start). */
  savedProxy: SavedProxy | null
  /** The client we started, to end an orphan at the next start. */
  clientPid: number | null
}

export function defaultVpnRecord(): VpnRecord {
  return { sealedLink: null, autoConnect: true, sites: [...DEFAULT_VPN_SITES], savedProxy: null, clientPid: null }
}

function savedProxyOf(v: unknown): SavedProxy | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  return {
    autoConfigUrl: typeof o['autoConfigUrl'] === 'string' ? o['autoConfigUrl'] : null,
    proxyEnable: typeof o['proxyEnable'] === 'number' ? o['proxyEnable'] : null
  }
}

export function loadVpnRecord(dir: string): VpnRecord {
  const d = defaultVpnRecord()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, VPN_FILE), 'utf8'))
  } catch {
    return d
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d
  const o = raw as Record<string, unknown>
  return {
    sealedLink: typeof o['sealedLink'] === 'string' && o['sealedLink'] ? o['sealedLink'] : null,
    autoConnect: typeof o['autoConnect'] === 'boolean' ? o['autoConnect'] : d.autoConnect,
    sites: Array.isArray(o['sites']) ? parseSites(o['sites']) : d.sites,
    savedProxy: savedProxyOf(o['savedProxy']),
    clientPid: typeof o['clientPid'] === 'number' && Number.isInteger(o['clientPid']) ? o['clientPid'] : null
  }
}

export function saveVpnRecord(dir: string, rec: VpnRecord): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, VPN_FILE), JSON.stringify(rec, null, 2), { encoding: 'utf8', mode: 0o600 })
}
