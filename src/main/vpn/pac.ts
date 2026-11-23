// 1.0.1: vpn — the PAC file Qclod serves to the system: listed sites through the tunnel, the rest DIRECT.

/** A marker in our PAC URL: a leftover of ours is recognised by it at the next start. */
export const PAC_PATH = '/qclod-vpn.pac'

export function pacScript(domains: readonly string[], httpPort: number): string {
  const list = JSON.stringify([...domains])
  return [
    'function FindProxyForURL(url, host) {',
    '  host = host.toLowerCase();',
    `  var d = ${list};`,
    '  for (var i = 0; i < d.length; i++) {',
    `    if (host === d[i] || dnsDomainIs(host, "." + d[i])) return "PROXY 127.0.0.1:${httpPort}";`,
    '  }',
    '  return "DIRECT";',
    '}',
    ''
  ].join('\n')
}

/** What the script answers, for tests: the same rule in TypeScript. */
export function pacDecision(domains: readonly string[], host: string): 'proxy' | 'direct' {
  const h = host.toLowerCase()
  return domains.some((d) => h === d || h.endsWith(`.${d}`)) ? 'proxy' : 'direct'
}
