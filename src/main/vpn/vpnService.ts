// 1.0.1: vpn — the Hysteria2 client as Qclod's child: started, watched, restarted, ended.
// The tunnel is for Claude Code (its process gets HTTPS_PROXY) and the listed sites (system PAC).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { DEFAULT_VPN_SITES, parseSites, type VpnStatus, type VpnView } from '../../shared/vpn'
import type { SecretBox } from '../ssh/secretBox'
import { clientConfig, parseHy2Link, type Hy2Link } from './link'
import { PAC_PATH, pacScript } from './pac'
import { backoffMs, claudeProxyEnv } from './proxyEnv'
import { applyPac, isOurPac, restorePac, type Registry } from './systemProxy'
import { loadVpnRecord, saveVpnRecord, type VpnRecord } from './vpnStore'

export interface ClientProcess {
  pid: number | undefined
  onLine(cb: (line: string) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export interface VpnDeps {
  dir: string
  box: SecretBox
  /** null — no system PAC here (a Mac in 1.0.1, a test build). */
  registry: Registry | null
  binaryPath(): string
  spawnClient?(binary: string, configPath: string): ClientProcess
  probe?(httpPort: number): Promise<number>
  freePort?(): Promise<number>
  /** Ends an orphan of an earlier run if it is our client. */
  killOrphan?(pid: number): Promise<void>
  onChange(view: VpnView): void
  log(message: string): void
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(t: unknown): void
}

/** «discard»: nothing listens on it locally — a request through it fails instead of going direct. */
export const DEAD_PORT = 9

const stripAnsi =(s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

/** A short reason from a client's log line, without addresses' secrets (the client logs none). */
export function logReason(line: string): string | null {
  const clean = stripAnsi(line)
  const m = /\b(FATAL|ERROR)\b\s+(.*)$/.exec(clean)
  if (!m) return null
  const [msg, json] = m[2]!.split(/\t(?=\{)/)
  let err = ''
  try {
    const o = json ? (JSON.parse(json) as Record<string, unknown>) : {}
    if (typeof o['error'] === 'string') err = `: ${o['error']}`
  } catch {
    /* plain text */
  }
  return `${msg!.trim()}${err}`.slice(0, 300)
}

export function nodeSpawnClient(binary: string, configPath: string): ClientProcess {
  const child = spawn(binary, ['client', '-c', configPath, '--disable-update-check'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const lines: Array<(l: string) => void> = []
  const feed = (buf: Buffer): void => {
    for (const l of buf.toString('utf8').split(/\r?\n/)) if (l.trim()) lines.forEach((cb) => cb(l))
  }
  child.stdout?.on('data', feed)
  child.stderr?.on('data', feed)
  let exited = false
  const exits: Array<(c: number | null) => void> = []
  const done = (code: number | null): void => {
    if (exited) return
    exited = true
    exits.forEach((cb) => cb(code))
  }
  child.on('exit', (code) => done(code))
  child.on('error', () => done(null))
  return {
    pid: child.pid,
    onLine: (cb) => lines.push(cb),
    onExit: (cb) => exits.push(cb),
    kill: () => {
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }
  }
}

export function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

/** HEAD https://api.anthropic.com through the local HTTP proxy: ms until the first answer. */
export function probeThrough(httpPort: number, timeoutMs = 10000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setTimeout(() => {
      req.destroy()
      reject(new Error('timeout'))
    }, timeoutMs)
    const req = request({ host: '127.0.0.1', port: httpPort, method: 'CONNECT', path: 'api.anthropic.com:443' })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer)
        socket.destroy()
        reject(new Error(`proxy ${res.statusCode}`))
        return
      }
      const tls = tlsConnect({ socket, servername: 'api.anthropic.com' }, () => {
        tls.write('HEAD / HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: close\r\n\r\n')
      })
      tls.once('data', () => {
        clearTimeout(timer)
        resolve(Date.now() - started)
        tls.destroy()
      })
      tls.once('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.end()
  })
}

export class VpnService {
  private rec: VpnRecord
  private status: VpnStatus = 'off'
  private enabled = false
  private ports: { socks: number; http: number } | null = null
  private portsReady: Promise<void> | null = null
  private child: ClientProcess | null = null
  private configPath: string | null = null
  private attempt = 0
  private retryTimer: unknown = null
  private probeTimer: ReturnType<typeof setInterval> | null = null
  private latencyMs: number | null = null
  private lastError: string | null = null
  private pac: { server: Server; port: number } | null = null
  private pacVersion = 0
  private pacApplied = false
  private readonly setT: (fn: () => void, ms: number) => unknown
  private readonly clearT: (t: unknown) => void

  constructor(private readonly deps: VpnDeps) {
    this.rec = loadVpnRecord(deps.dir)
    this.setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearT = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  }

  // ---- what the window sees ----

  private link(): Hy2Link | null {
    if (!this.rec.sealedLink) return null
    try {
      return parseHy2Link(this.deps.box.open(this.rec.sealedLink))
    } catch {
      return null
    }
  }

  view(): VpnView {
    const link = this.link()
    return {
      status: this.status,
      configured: link !== null,
      host: link?.host ?? null,
      name: link?.name ?? null,
      autoConnect: this.rec.autoConnect,
      enabled: this.enabled,
      sites: [...this.rec.sites],
      latencyMs: this.latencyMs,
      lastError: this.lastError,
      canStore: this.deps.box.available()
    }
  }

  private changed(): void {
    this.deps.onChange(this.view())
  }

  private save(): void {
    try {
      saveVpnRecord(this.deps.dir, this.rec)
    } catch (e) {
      this.deps.log(`VPN: не удалось сохранить настройки: ${(e as Error).message}`)
    }
  }

  // ---- settings ----

  /** An empty string forgets the link (and disconnects). Throws a short reason. */
  async setLink(text: string): Promise<VpnView> {
    if (text.trim() === '') {
      await this.disconnect()
      this.rec.sealedLink = null
      this.save()
      this.changed()
      return this.view()
    }
    parseHy2Link(text)
    if (!this.deps.box.available()) throw new Error('Система не даёт зашифровать ссылку (safeStorage)')
    this.rec.sealedLink = this.deps.box.seal(text.trim())
    this.save()
    this.lastError = null
    if (this.enabled) await this.restartClient()
    this.changed()
    return this.view()
  }

  setOptions(o: { autoConnect?: boolean; sites?: string[] | 'defaults' }): VpnView {
    if (typeof o.autoConnect === 'boolean') this.rec.autoConnect = o.autoConnect
    if (o.sites === 'defaults') this.rec.sites = [...DEFAULT_VPN_SITES]
    else if (o.sites) this.rec.sites = parseSites(o.sites)
    this.save()
    if (o.sites && this.pacApplied) void this.applySystemPac()
    this.changed()
    return this.view()
  }

  // ---- for Claude Code ----

  /**
   * Env for a new local Claude Code process. With the VPN on it always points at
   * our local proxy — even while the tunnel is down: Claude waits, it does not go direct.
   */
  async claudeEnv(): Promise<Record<string, string> | null> {
    if (!this.enabled) return null
    await this.ensurePorts().catch(() => undefined)
    // No port could be had: a proxy nobody listens on, so the agent cannot go around the tunnel.
    return claudeProxyEnv(this.ports?.http ?? DEAD_PORT)
  }

  // ---- lifecycle ----

  /** At start: an orphan client and a leftover PAC of an earlier crash go; then auto-connect. */
  async startup(): Promise<void> {
    if (this.rec.clientPid !== null) {
      await this.deps.killOrphan?.(this.rec.clientPid).catch(() => undefined)
      this.rec.clientPid = null
      this.save()
    }
    if (this.deps.registry) {
      try {
        const now = await this.deps.registry.read('AutoConfigURL')
        if (isOurPac(now)) await restorePac(this.deps.registry, this.rec.savedProxy)
      } catch (e) {
        this.deps.log(`VPN: не удалось вернуть системный прокси: ${(e as Error).message}`)
      }
      if (this.rec.savedProxy) {
        this.rec.savedProxy = null
        this.save()
      }
    }
    if (this.rec.autoConnect && this.link()) await this.connect()
  }

  async connect(): Promise<VpnView> {
    if (!this.link()) {
      this.lastError = 'Нет ссылки hysteria2:// — вставьте её в настройках VPN'
      this.status = 'error'
      this.changed()
      return this.view()
    }
    this.enabled = true
    this.attempt = 0
    this.lastError = null
    try {
      await this.ensurePorts()
    } catch (e) {
      this.fail(`Нет свободного порта: ${(e as Error).message}`)
      return this.view()
    }
    this.startClient()
    return this.view()
  }

  /** The local listeners' ports: the same for the whole run unless a port was taken. One pick at a time. */
  private ensurePorts(): Promise<void> {
    if (this.ports) return Promise.resolve()
    if (!this.portsReady) {
      const pick = (async () => {
        const free = this.deps.freePort ?? freeLocalPort
        this.ports = { socks: await free(), http: await free() }
      })()
      this.portsReady = pick
      pick.catch(() => {
        if (this.portsReady === pick) this.portsReady = null
      })
    }
    return this.portsReady
  }

  async disconnect(): Promise<VpnView> {
    this.enabled = false
    this.cancelRetry()
    this.stopProbe()
    this.stopClient()
    await this.removeSystemPac()
    this.latencyMs = null
    this.status = 'off'
    this.changed()
    return this.view()
  }

  /** Quitting Qclod: the client ends and the user's proxy comes back. */
  async dispose(): Promise<void> {
    this.enabled = false
    this.cancelRetry()
    this.stopProbe()
    this.stopClient()
    await this.removeSystemPac()
    this.pac?.server.close()
    this.pac = null
  }

  private async restartClient(): Promise<void> {
    this.cancelRetry()
    this.stopClient()
    this.attempt = 0
    this.startClient()
  }

  private startClient(): void {
    const link = this.link()
    if (!link || !this.ports || !this.enabled) return
    this.status = this.status === 'connected' || this.status === 'reconnecting' ? 'reconnecting' : 'connecting'
    this.changed()

    const dir = join(this.deps.dir, 'vpn')
    let configPath: string
    try {
      mkdirSync(dir, { recursive: true })
      configPath = join(dir, `client-${randomBytes(6).toString('hex')}.json`)
      writeFileSync(configPath, JSON.stringify(clientConfig(link, this.ports)), { mode: 0o600 })
    } catch (e) {
      this.fail(`Не удалось записать конфиг клиента: ${(e as Error).message}`)
      return
    }
    this.configPath = configPath

    let child: ClientProcess
    try {
      child = (this.deps.spawnClient ?? nodeSpawnClient)(this.deps.binaryPath(), configPath)
    } catch (e) {
      this.dropConfig()
      this.fail(`Клиент Hysteria2 не запустился: ${(e as Error).message}`)
      return
    }
    this.child = child
    this.rec.clientPid = child.pid ?? null
    this.save()

    child.onLine((line) => {
      if (this.child !== child) return
      // The client has read its config by its first line: the secrets leave the disk.
      this.dropConfig()
      if (/connected to server/i.test(line)) this.onConnected()
      const reason = logReason(line)
      if (reason) {
        this.lastError = reason
        this.deps.log(`VPN: ${reason}`)
        this.changed()
      }
    })
    child.onExit((code) => {
      if (this.child !== child) return
      this.child = null
      this.dropConfig()
      this.rec.clientPid = null
      this.save()
      this.stopProbe()
      this.latencyMs = null
      if (!this.enabled) return
      if (!this.lastError) this.lastError = `Клиент Hysteria2 завершился (код ${code ?? '—'})`
      // A port taken by someone else: new ports on the next try.
      if (/address already in use|bind/i.test(this.lastError)) {
        this.ports = null
        this.portsReady = null
      }
      this.status = 'reconnecting'
      this.changed()
      const delay = backoffMs(this.attempt++)
      this.retryTimer = this.setT(() => {
        this.retryTimer = null
        if (!this.enabled) return
        if (!this.ports) void this.connect()
        else this.startClient()
      }, delay)
    })
  }

  private onConnected(): void {
    this.status = 'connected'
    this.attempt = 0
    this.lastError = null
    this.changed()
    if (!this.pacApplied) void this.applySystemPac()
    void this.measure()
    if (!this.probeTimer) {
      this.probeTimer = setInterval(() => void this.measure(), 60_000)
      this.probeTimer.unref?.()
    }
  }

  private async measure(): Promise<void> {
    if (!this.ports || this.status !== 'connected') return
    try {
      this.latencyMs = await (this.deps.probe ?? probeThrough)(this.ports.http)
    } catch {
      this.latencyMs = null
    }
    this.changed()
  }

  private fail(reason: string): void {
    this.lastError = reason
    this.status = 'error'
    this.deps.log(`VPN: ${reason}`)
    this.changed()
  }

  private stopClient(): void {
    const c = this.child
    this.child = null
    c?.kill()
    this.dropConfig()
    if (this.rec.clientPid !== null) {
      this.rec.clientPid = null
      this.save()
    }
  }

  private dropConfig(): void {
    if (!this.configPath) return
    rmSync(this.configPath, { force: true })
    this.configPath = null
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) this.clearT(this.retryTimer)
    this.retryTimer = null
  }

  private stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer)
    this.probeTimer = null
  }

  // ---- the system PAC (Windows) ----

  private async pacServer(): Promise<number> {
    if (this.pac) return this.pac.port
    const server = createServer((req, res) => {
      if (!req.url?.startsWith(PAC_PATH) || !this.ports) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/x-ns-proxy-autoconfig',
        'Cache-Control': 'no-store'
      })
      res.end(pacScript(this.rec.sites, this.ports.http))
    })
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const a = server.address()
        resolve(typeof a === 'object' && a ? a.port : 0)
      })
    })
    this.pac = { server, port }
    return port
  }

  private async applySystemPac(): Promise<void> {
    const reg = this.deps.registry
    if (!reg || !this.enabled) return
    try {
      const port = await this.pacServer()
      this.pacVersion += 1
      const saved = await applyPac(reg, `http://127.0.0.1:${port}${PAC_PATH}?v=${this.pacVersion}`, this.rec.savedProxy)
      this.rec.savedProxy = saved
      this.pacApplied = true
      this.save()
    } catch (e) {
      this.deps.log(`VPN: не удалось включить сайты через VPN: ${(e as Error).message}`)
    }
  }

  private async removeSystemPac(): Promise<void> {
    const reg = this.deps.registry
    if (!reg || !this.pacApplied) return
    try {
      await restorePac(reg, this.rec.savedProxy)
      this.rec.savedProxy = null
      this.pacApplied = false
      this.save()
    } catch (e) {
      this.deps.log(`VPN: не удалось вернуть системный прокси: ${(e as Error).message}`)
    }
  }
}
