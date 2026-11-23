// 1.0.1: vpn — what the window knows about the VPN. Never the link's secrets.

export type VpnStatus = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface VpnView {
  status: VpnStatus
  /** A link is stored (sealed). */
  configured: boolean
  /** Host of the stored link, no password. */
  host: string | null
  /** The #fragment of the link. */
  name: string | null
  autoConnect: boolean
  /** The user wants it on (survives a fall: reconnects). */
  enabled: boolean
  sites: string[]
  /** HEAD to api.anthropic.com through the tunnel, ms. */
  latencyMs: number | null
  lastError: string | null
  /** The OS can seal the link (safeStorage). */
  canStore: boolean
  /** The fixed local SOCKS5 port for other apps (Telegram): 127.0.0.1 only. */
  socksPort: number
}

/** The first port tried for the SOCKS5 listener; kept across runs once chosen. */
export const DEFAULT_SOCKS_PORT = 10808

/** Telegram Desktop's own «add proxy» link: opening it offers to add and turn the proxy on. */
export function telegramProxyUrl(port: number): string {
  return `tg://socks?server=127.0.0.1&port=${port}`
}

/** Owner's presets (decision 3); subdomains are included by the PAC. */
export const DEFAULT_VPN_SITES: readonly string[] = Object.freeze([
  'anthropic.com',
  'claude.ai',
  'claude.com',
  'openai.com',
  'chatgpt.com',
  'oaistatic.com',
  'oaiusercontent.com',
  'gemini.google.com',
  'aistudio.google.com',
  'generativelanguage.googleapis.com',
  'x.com',
  'twitter.com',
  'twimg.com',
  'instagram.com',
  'cdninstagram.com',
  'facebook.com',
  'fbcdn.net',
  'youtube.com',
  'googlevideo.com',
  'ytimg.com',
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'discordapp.net',
  'linkedin.com',
  'telegram.org',
  't.me',
  'telegram.me',
  'web.telegram.org',
  'notion.so',
  'medium.com',
  'spotify.com'
])

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** One domain per line (or comma/space); `*.`/scheme/path stripped, lowercased, unique, at most 500. */
export function parseSites(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.join('\n') : typeof input === 'string' ? input : ''
  const out: string[] = []
  for (let part of raw.split(/[\s,;]+/)) {
    part = part.trim().toLowerCase()
    if (!part) continue
    part = part.replace(/^[a-z]+:\/\//, '').replace(/[/:?#].*$/, '').replace(/^\*?\./, '').replace(/\.$/, '')
    if (DOMAIN.test(part) && !out.includes(part)) out.push(part)
    if (out.length >= 500) break
  }
  return out
}
