// 1.0.1: vpn — the hysteria2:// share link and the client config made of it.

export interface Hy2Link {
  auth: string
  host: string
  /** The main port. */
  port: number
  /** Port hopping range(s) from `mport` or a multi-port authority, e.g. "20000-40000". */
  hop: string | null
  sni: string | null
  insecure: boolean
  pinSHA256: string | null
  obfs: { type: 'salamander'; password: string } | null
  name: string | null
}

const PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/

function validPorts(spec: string): boolean {
  if (!PORTS.test(spec)) return false
  return spec.split(/[,-]/).every((p) => Number(p) >= 1 && Number(p) <= 65535)
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Throws an Error with a short Russian reason (never the link itself). */
export function parseHy2Link(input: string): Hy2Link {
  const text = input.trim()
  const m = /^(hysteria2|hy2):\/\/(.*)$/i.exec(text)
  if (!m) throw new Error('Ссылка должна начинаться с hysteria2://')
  let rest = m[2]!
  let name: string | null = null
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    name = decode(rest.slice(hash + 1)).trim() || null
    rest = rest.slice(0, hash)
  }
  let query = ''
  const q = rest.indexOf('?')
  if (q >= 0) {
    query = rest.slice(q + 1)
    rest = rest.slice(0, q)
  }
  rest = rest.replace(/\/+$/, '')
  const at = rest.lastIndexOf('@')
  if (at <= 0) throw new Error('В ссылке нет пароля (auth@host)')
  const auth = decode(rest.slice(0, at))
  const authority = rest.slice(at + 1)

  let host: string
  let portSpec: string
  const v6 = /^\[([0-9a-f:.]+)\](?::(.+))?$/i.exec(authority)
  if (v6) {
    host = v6[1]!
    portSpec = v6[2] ?? '443'
  } else {
    const colon = authority.indexOf(':')
    host = colon >= 0 ? authority.slice(0, colon) : authority
    portSpec = colon >= 0 ? authority.slice(colon + 1) : '443'
  }
  if (!host || !/^[a-z0-9.\-:]+$/i.test(host)) throw new Error('В ссылке неверный адрес сервера')
  if (!validPorts(portSpec)) throw new Error('В ссылке неверный порт')

  const params = new URLSearchParams(query)
  const get = (k: string): string | null => {
    const v = params.get(k)
    return v === null || v === '' ? null : v
  }

  // "8444" or a multi-port authority "8444,20000-40000" / "20000-40000".
  const first = portSpec.split(',')[0]!
  const port = first.includes('-') ? Number(first.split('-')[0]) : Number(first)
  const extra = portSpec.includes(',') || first.includes('-') ? portSpec : null
  let hop = extra
  const mport = get('mport')
  if (mport) {
    if (!validPorts(mport)) throw new Error('В ссылке неверный mport')
    hop = mport
  }

  const obfsType = get('obfs')
  let obfs: Hy2Link['obfs'] = null
  if (obfsType) {
    if (obfsType !== 'salamander') throw new Error(`Неизвестная обфускация: ${obfsType}`)
    const password = get('obfs-password')
    if (!password) throw new Error('В ссылке нет obfs-password')
    obfs = { type: 'salamander', password }
  }
  const insecure = ['1', 'true'].includes((get('insecure') ?? '').toLowerCase())

  return {
    auth,
    host,
    port,
    hop,
    sni: get('sni') ?? get('peer'),
    insecure,
    pinSHA256: get('pinSHA256'),
    obfs,
    name
  }
}

/** The `server:` of the official client: port hopping is a port list in the address. */
export function serverAddress(link: Hy2Link): string {
  const h = link.host.includes(':') ? `[${link.host}]` : link.host
  if (!link.hop) return `${h}:${link.port}`
  const parts = link.hop.split(',')
  const ports = parts.includes(String(link.port)) ? parts : [String(link.port), ...parts]
  return `${h}:${ports.join(',')}`
}

/** The client config (JSON; the client reads it by its extension). */
export function clientConfig(link: Hy2Link, ports: { socks: number; http: number }): Record<string, unknown> {
  return {
    server: serverAddress(link),
    auth: link.auth,
    tls: {
      ...(link.sni ? { sni: link.sni } : {}),
      insecure: link.insecure,
      ...(link.pinSHA256 ? { pinSHA256: link.pinSHA256 } : {})
    },
    ...(link.obfs ? { obfs: { type: 'salamander', salamander: { password: link.obfs.password } } } : {}),
    ...(link.hop ? { transport: { udp: { hopInterval: '30s' } } } : {}),
    socks5: { listen: `127.0.0.1:${ports.socks}` },
    http: { listen: `127.0.0.1:${ports.http}` }
  }
}
