// 1.0.1: vpn. All values here are made up.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_VPN_SITES, parseSites } from '@shared/vpn'
import { clientConfig, parseHy2Link, serverAddress } from '@main/vpn/link'
import { pacDecision, pacScript, PAC_PATH } from '@main/vpn/pac'
import { backoffMs, claudeProxyEnv, withProxyEnv } from '@main/vpn/proxyEnv'
import { applyPac, restorePac, type Registry } from '@main/vpn/systemProxy'
import { loadVpnRecord } from '@main/vpn/vpnStore'
import { logReason, VpnService, type ClientProcess } from '@main/vpn/vpnService'
import { sanitizeVpnLink, sanitizeVpnOptions } from '@main/tabs/sanitize'

vi.mock('electron', () => ({}))

const LINK =
  'hysteria2://s3cret-auth@vpn.example.org:8444/?sni=vpn.example.org&obfs=salamander&obfs-password=obf-pass&mport=20000-40000#My%20VPN'

describe('the hysteria2:// link', () => {
  test('auth, host, port, sni, obfs, mport and the name', () => {
    const l = parseHy2Link(LINK)
    expect(l).toEqual({
      auth: 's3cret-auth',
      host: 'vpn.example.org',
      port: 8444,
      hop: '20000-40000',
      sni: 'vpn.example.org',
      insecure: false,
      pinSHA256: null,
      obfs: { type: 'salamander', password: 'obf-pass' },
      name: 'My VPN'
    })
    expect(serverAddress(l)).toBe('vpn.example.org:8444,20000-40000')
  })

  test('insecure, pinSHA256, hy2:// and a multi-port authority', () => {
    const l = parseHy2Link('hy2://u:p@1.2.3.4:20000-30000?insecure=1&pinSHA256=AB:CD')
    expect(l.auth).toBe('u:p')
    expect(l.port).toBe(20000)
    expect(l.hop).toBe('20000-30000')
    expect(l.insecure).toBe(true)
    expect(l.pinSHA256).toBe('AB:CD')
    expect(l.name).toBeNull()
    expect(serverAddress(l)).toBe('1.2.3.4:20000,20000-30000')
  })

  test('default port 443, IPv6, no hopping', () => {
    expect(serverAddress(parseHy2Link('hysteria2://a@host.test'))).toBe('host.test:443')
    expect(serverAddress(parseHy2Link('hysteria2://a@[2001:db8::1]:9000/'))).toBe('[2001:db8::1]:9000')
  })

  test('bad links are refused with a reason that holds no secret', () => {
    for (const bad of ['vless://a@b:1', 'hysteria2://host:1', 'hysteria2://a@h:99999', 'hysteria2://a@h:1?obfs=xor']) {
      let msg = ''
      try {
        parseHy2Link(bad)
      } catch (e) {
        msg = (e as Error).message
      }
      expect(msg).not.toBe('')
      expect(msg).not.toContain('a@')
    }
  })

  test('the client config: listeners on 127.0.0.1, hop interval, obfs', () => {
    const c = clientConfig(parseHy2Link(LINK), { socks: 1080, http: 8080 })
    expect(c).toEqual({
      server: 'vpn.example.org:8444,20000-40000',
      auth: 's3cret-auth',
      tls: { sni: 'vpn.example.org', insecure: false },
      obfs: { type: 'salamander', salamander: { password: 'obf-pass' } },
      transport: { udp: { hopInterval: '30s' } },
      socks5: { listen: '127.0.0.1:1080' },
      http: { listen: '127.0.0.1:8080' }
    })
  })
})

describe('PAC and sites', () => {
  test('listed domains and their subdomains go through the tunnel, the rest DIRECT', () => {
    const d = ['claude.ai', 'x.com']
    expect(pacDecision(d, 'claude.ai')).toBe('proxy')
    expect(pacDecision(d, 'API.Claude.ai')).toBe('proxy')
    expect(pacDecision(d, 'notclaude.ai')).toBe('direct')
    expect(pacDecision(d, 'example.com')).toBe('direct')
    const script = pacScript(d, 8080)
    expect(script).toContain('PROXY 127.0.0.1:8080')
    expect(script).toContain('return "DIRECT"')
    // The script itself answers the same.
    const find = new Function('dnsDomainIs', `${script}; return FindProxyForURL`)((h: string, s: string) =>
      h.endsWith(s)
    ) as (u: string, h: string) => string
    expect(find('https://api.claude.ai/', 'api.claude.ai')).toBe('PROXY 127.0.0.1:8080')
    expect(find('https://notclaude.ai/', 'notclaude.ai')).toBe('DIRECT')
  })

  test('parseSites strips schemes, *., paths; drops junk and duplicates', () => {
    expect(parseSites('https://Claude.ai/x\n*.x.com, x.com\nnot a domain\n\n.medium.com')).toEqual([
      'claude.ai',
      'x.com',
      'medium.com'
    ])
    expect(DEFAULT_VPN_SITES).toContain('anthropic.com')
  })
})

describe('Claude Code env', () => {
  test('HTTPS_PROXY/HTTP_PROXY at the local port, localhost excluded', () => {
    const env = claudeProxyEnv(8080)
    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:8080')
    expect(env['HTTP_PROXY']).toBe('http://127.0.0.1:8080')
    expect(env['NO_PROXY']).toBe('localhost,127.0.0.1,::1')
  })

  test('the user own proxy vars are replaced, the rest kept; no proxy — no env', () => {
    const merged = withProxyEnv({ PATH: 'p', Https_Proxy: 'http://other' }, claudeProxyEnv(1))!
    expect(merged['PATH']).toBe('p')
    expect(merged['Https_Proxy']).toBeUndefined()
    expect(merged['HTTPS_PROXY']).toBe('http://127.0.0.1:1')
    expect(withProxyEnv({ PATH: 'p' }, null)).toBeUndefined()
  })

  test('back-off 2/5/15/30 s, then 30', () => {
    expect([0, 1, 2, 3, 4, 9].map(backoffMs)).toEqual([2000, 5000, 15000, 30000, 30000, 30000])
  })
})

function fakeRegistry(init: Record<string, string | number> = {}): Registry & { values: Map<string, string | number> } {
  const values = new Map(Object.entries(init))
  return {
    values,
    read: async (n) => values.get(n) ?? null,
    write: async (n, v) => void values.set(n, v),
    remove: async (n) => void values.delete(n),
    notify: async () => undefined
  }
}

describe('system proxy: save and restore', () => {
  const OURS = `http://127.0.0.1:5555${PAC_PATH}?v=1`

  test('the user own PAC is saved and given back', async () => {
    const reg = fakeRegistry({ AutoConfigURL: 'http://corp/proxy.pac', ProxyEnable: 0 })
    const saved = await applyPac(reg, OURS, null)
    expect(saved).toEqual({ autoConfigUrl: 'http://corp/proxy.pac', proxyEnable: 0 })
    expect(reg.values.get('AutoConfigURL')).toBe(OURS)
    expect(await restorePac(reg, saved)).toBe(true)
    expect(reg.values.get('AutoConfigURL')).toBe('http://corp/proxy.pac')
  })

  test('no PAC before — none after', async () => {
    const reg = fakeRegistry({ ProxyEnable: 1 })
    const saved = await applyPac(reg, OURS, null)
    await restorePac(reg, saved)
    expect(reg.values.has('AutoConfigURL')).toBe(false)
    expect(reg.values.get('ProxyEnable')).toBe(1)
  })

  test('a leftover of ours is not saved as the user own', async () => {
    const reg = fakeRegistry({ AutoConfigURL: OURS })
    expect((await applyPac(reg, OURS, null)).autoConfigUrl).toBeNull()
    const prev = { autoConfigUrl: 'http://corp/p.pac', proxyEnable: null }
    expect(await applyPac(reg, OURS, prev)).toEqual(prev)
  })

  test('someone else PAC set meanwhile is left alone', async () => {
    const reg = fakeRegistry({ AutoConfigURL: 'http://other/p.pac' })
    expect(await restorePac(reg, { autoConfigUrl: null, proxyEnable: null })).toBe(false)
    expect(reg.values.get('AutoConfigURL')).toBe('http://other/p.pac')
  })
})

describe('sanitize', () => {
  test('link: a string up to 4096', () => {
    expect(sanitizeVpnLink('x')).toBe('x')
    expect(sanitizeVpnLink(5)).toBeNull()
    expect(sanitizeVpnLink('a'.repeat(5000))).toBeNull()
  })
  test('options: known fields only', () => {
    expect(sanitizeVpnOptions({ autoConnect: false, sites: 'a.com\nb', evil: 1 })).toEqual({
      autoConnect: false,
      sites: ['a.com']
    })
    expect(sanitizeVpnOptions({ sites: 'defaults' })).toEqual({ sites: 'defaults' })
    expect(sanitizeVpnOptions(null)).toEqual({})
  })
})

test('logReason reads the client error lines', () => {
  expect(logReason('2026\t\x1b[31mFATAL\x1b[0m\tfailed to initialize client\t{"error": "auth error"}')).toBe(
    'failed to initialize client: auth error'
  )
  expect(logReason('2026\tINFO\tconnected to server')).toBeNull()
})

describe('VpnService', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function setup(opts: { autoConnect?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-vpn-'))
    dirs.push(dir)
    const children: Array<ClientProcess & { line(l: string): void; exit(c: number): void; killed: boolean }> = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    const reg = fakeRegistry()
    let port = 40000
    const svc = new VpnService({
      dir,
      box: { available: () => true, seal: (s) => Buffer.from(s).toString('base64'), open: (s) => Buffer.from(s, 'base64').toString() },
      registry: reg,
      binaryPath: () => 'hysteria.exe',
      freePort: async () => port++,
      probe: async () => 77,
      spawnClient: () => {
        const lines: Array<(l: string) => void> = []
        const exits: Array<(c: number | null) => void> = []
        const c = {
          pid: 1234,
          killed: false,
          onLine: (cb: (l: string) => void) => void lines.push(cb),
          onExit: (cb: (c: number | null) => void) => void exits.push(cb),
          kill: () => {
            c.killed = true
          },
          line: (l: string) => lines.forEach((cb) => cb(l)),
          exit: (code: number) => exits.forEach((cb) => cb(code))
        }
        children.push(c)
        return c
      },
      onChange: () => undefined,
      log: () => undefined,
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      clearTimeout: () => undefined
    })
    if (opts.autoConnect === false) svc.setOptions({ autoConnect: false })
    return { svc, dir, children, timers, reg }
  }

  test('connect → config on disk until the first line → connected, PAC on, env for Claude', async () => {
    const { svc, dir, children, reg } = setup()
    await svc.setLink(LINK)
    expect(await svc.claudeEnv()).toBeNull()
    await svc.connect()
    expect(svc.view().status).toBe('connecting')
    expect(readdirSync(join(dir, 'vpn'))).toHaveLength(1)
    // Claude waits at the local proxy even before the tunnel is up.
    expect((await svc.claudeEnv())?.['HTTPS_PROXY']).toBe('http://127.0.0.1:40001')
    children[0]!.line('INFO\tconnected to server')
    expect(readdirSync(join(dir, 'vpn'))).toHaveLength(0)
    expect(svc.view().status).toBe('connected')
    await vi.waitFor(() => expect(String(reg.values.get('AutoConfigURL'))).toContain(PAC_PATH))
    await vi.waitFor(() => expect(svc.view().latencyMs).toBe(77))
    // The window never sees the secrets.
    const view = JSON.stringify(svc.view())
    expect(view).not.toContain('s3cret')
    expect(view).not.toContain('obf-pass')
    expect(svc.view()).toMatchObject({ host: 'vpn.example.org', name: 'My VPN' })
    expect(JSON.stringify(loadVpnRecord(dir))).not.toContain('s3cret-auth')

    await svc.disconnect()
    expect(children[0]!.killed).toBe(true)
    expect(reg.values.has('AutoConfigURL')).toBe(false)
    expect(svc.view().status).toBe('off')
    expect(await svc.claudeEnv()).toBeNull()
    await svc.dispose()
  })

  test('a fall restarts with back-off, keeping the same proxy port', async () => {
    const { svc, children, timers } = setup()
    await svc.setLink(LINK)
    await svc.connect()
    children[0]!.line('INFO\tconnected to server')
    children[0]!.exit(1)
    expect(svc.view().status).toBe('reconnecting')
    expect(timers.map((t) => t.ms)).toEqual([2000])
    timers[0]!.fn()
    expect(children).toHaveLength(2)
    children[1]!.exit(1)
    expect(timers.map((t) => t.ms)).toEqual([2000, 5000])
    expect((await svc.claudeEnv())?.['HTTPS_PROXY']).toBe('http://127.0.0.1:40001')
    await svc.dispose()
  })

  test('startup: our leftover PAC goes; auto-connect only with a link', async () => {
    const { svc, reg, children } = setup()
    reg.values.set('AutoConfigURL', `http://127.0.0.1:1${PAC_PATH}`)
    await svc.startup()
    expect(reg.values.has('AutoConfigURL')).toBe(false)
    expect(children).toHaveLength(0)
    await svc.setLink(LINK)
    await svc.startup()
    expect(children).toHaveLength(1)
    await svc.dispose()
  })

  test('connect without a link is an error in words', async () => {
    const { svc } = setup()
    await svc.connect()
    expect(svc.view().status).toBe('error')
    expect(svc.view().lastError).toMatch(/ссылк/i)
  })
})
