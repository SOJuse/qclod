/**
 * Every server and its relay (stage 6). `connect` is the checklist the window
 * shows — ssh, the sign-in, Claude Code there, the relay, the Claude account —
 * and after it one relay channel per server, kept by RelayClient.
 *
 * Before the relay there are only three separate ssh runs (decision 2): the
 * probe, the upload of the binary, its `setup`. Claude Code is never installed
 * by Qclod (I14): a missing one is said and the checklist stops there.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { PermissionRule } from '../agent/permissionStore'
import type {
  ConnectStep,
  ServerConnState,
  ServerEntry,
  ServerView,
  TabServer,
  TabState
} from '../../shared/types'
import {

  type FsEntry,
  type HostInfo,
  type RelayMethod,
  type RestartResult,
  type ServerAuth
} from '../../shared/relayProtocol'
import { CONNECT_STEP_TEXT } from '../../shared/serverTexts'
import type { AskpassServer } from './askpass'
import type { HostStore, SaveEntry } from './hostStore'
import { PROBE_SCRIPT, claudeStep, parseProbe, type ProbeResult } from './probe'
import { INSTALL_SCRIPT, ensureLocalRelay, httpsDownload, needsUpdate, type RelayManifest } from './relayInstaller'
import { knownHostsPath, remoteCommand, type SshTarget } from './sshArgs'
import { classifySshFailure, sshRun as realSshRun, type SshRunResult } from './sshRun'

/** What HostManager needs of a relay channel (RelayClient has it all). */
export interface RelayLink {
  readonly state: 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'needsAuth' | 'hostKeyChanged'
  readonly lastProblem?: string | undefined
  connect(interactive: boolean): Promise<{ proto: number; relay: string; binary: string }>
  call<T>(m: RelayMethod, p: unknown, o?: { timeoutMs?: number }): Promise<T>
  onState(cb: (s: RelayLink['state'], problem?: string) => void): () => void
  close(): void
}

export const STEP_TEXT = CONNECT_STEP_TEXT

export const INSTALLING_TEXT = 'Ставлю посредник Qclod в ~/.qclod…'
export const RELAY_LATER_TEXT = 'Посредник обновится, когда агенты на сервере закончат работу'
export const NOT_LOGGED_IN_TEXT = 'На сервере не выполнен вход в Claude'
export const ACCOUNT_UNKNOWN_TEXT = 'Аккаунт: не удалось узнать'
export const RELAY_PROTO_TEXT = 'Посредник на сервере другой версии. Нажмите «Обновить посредник».'
export const NO_MANIFEST_TEXT = 'В этой сборке Qclod нет посредника для сервера.'

export function lingerText(user: string): string {
  return (
    'Агент может остановиться, когда вы выйдете из ssh. Чтобы он жил всегда, выполните на сервере один раз: ' +
    `sudo loginctl enable-linger ${user}`
  )
}

export function hostKeyChangedText(host: string, userData: string): string {
  return (
    `Ключ сервера ${host} изменился. Это может быть подмена, поэтому Qclod не подключается. ` +
    `Если сервер переустанавливали, удалите старый ключ: ssh-keygen -R ${host} -f "${knownHostsPath(userData)}"`
  )
}

export type SshRunner = (
  t: SshTarget,
  remote: string,
  o: { stdin?: Buffer | string; interactive: boolean; hostId: string; timeoutMs?: number }
) => Promise<SshRunResult>

export interface HostManagerDeps {
  store: HostStore
  askpass: AskpassServer
  userData: string
  appVersion: string
  manifest: RelayManifest | null
  onChanged: (v: ServerView[]) => void
  onProgress: (hostId: string, steps: ConnectStep[]) => void
  openTab: (cwd: string, server: TabServer) => TabState
  rules: () => PermissionRule[]
  autoAnswerMs: () => number
  /** The relay channel of one server (RelayClient over sshTransport). */
  makeClient: (entry: ServerEntry) => RelayLink
  run?: SshRunner
  download?: (url: string, dest: string) => Promise<void>
  /** Test builds: QCLOD_RELAY_BINARY_DIR. */
  localRelayDir?: string
  log?: (line: string) => void
}

interface HostRuntime {
  client: RelayLink | null
  unsubscribe: (() => void) | null
  state: ServerConnState
  problem?: string
  info?: HostInfo & { claudeVersion: string | null }
  account?: ServerAuth
  relayUpdate?: 'pending' | 'required'
  probe?: ProbeResult
  connecting: Promise<boolean> | null
}

const PROBE_TIMEOUT_MS = 90_000
const INSTALL_TIMEOUT_MS = 10 * 60_000

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
}

function isProtoError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'proto'
}

function targetOf(e: ServerEntry): SshTarget {
  return {
    target: e.target,
    ...(e.port !== undefined ? { port: e.port } : {}),
    ...(e.identityFile ? { identityFile: e.identityFile } : {})
  }
}

/** The host part of user@host, for ssh-keygen -R. */
function hostPart(target: string): string {
  const at = target.lastIndexOf('@')
  return at >= 0 ? target.slice(at + 1) : target
}

export class HostManager {
  private readonly hosts = new Map<string, HostRuntime>()
  private readonly run: SshRunner

  constructor(private readonly deps: HostManagerDeps) {
    this.run = deps.run ?? realSshRun
  }

  private rt(id: string): HostRuntime {
    let r = this.hosts.get(id)
    if (!r) {
      r = { client: null, unsubscribe: null, state: 'idle', connecting: null }
      this.hosts.set(id, r)
    }
    return r
  }

  list(): ServerView[] {
    return this.deps.store.list().map((e) => {
      const r = this.hosts.get(e.id)
      return {
        ...e,
        state: r?.state ?? 'idle',
        ...(r?.problem ? { problem: r.problem } : {}),
        hasPassword: this.deps.store.hasPassword(e.id),
        canStorePassword: this.deps.store.canStorePasswords(),
        ...(r?.info ? { info: r.info } : {}),
        ...(r?.account ? { account: r.account } : {}),
        ...(r?.relayUpdate ? { relayUpdate: r.relayUpdate } : {})
      }
    })
  }

  canStorePasswords(): boolean {
    return this.deps.store.canStorePasswords()
  }

  private changed(): void {
    this.deps.onChanged(this.list())
  }

  private setState(id: string, state: ServerConnState, problem?: string): void {
    const r = this.rt(id)
    r.state = state
    if (problem) r.problem = problem
    else delete r.problem
    this.changed()
  }

  save(e: SaveEntry, password?: string): ServerView[] {
    const saved = this.deps.store.save(e)
    if (saved.auth === 'key') this.deps.store.setPassword(saved.id, null)
    else if (password !== undefined && password !== '') this.deps.store.setPassword(saved.id, password)
    this.changed()
    return this.list()
  }

  remove(id: string): ServerView[] {
    const r = this.hosts.get(id)
    r?.unsubscribe?.()
    r?.client?.close()
    this.hosts.delete(id)
    this.deps.store.remove(id)
    this.changed()
    return this.list()
  }

  forgetPassword(id: string): void {
    this.deps.store.setPassword(id, null)
    this.changed()
  }

  /** The person said «Запомнить» when ssh asked (askpass). */
  rememberPassword(id: string, password: string): void {
    this.deps.store.setPassword(id, password)
    this.changed()
  }

  /** The checklist; true when the server is online with its relay. One at a time per server. */
  connect(id: string, interactive: boolean): Promise<boolean> {
    const r = this.rt(id)
    if (r.connecting) return r.connecting
    const p = this.runChecklist(id, interactive).finally(() => {
      r.connecting = null
    })
    r.connecting = p
    return p
  }

  private async runChecklist(id: string, interactive: boolean): Promise<boolean> {
    const entry = this.deps.store.get(id)
    if (!entry) return false
    const r = this.rt(id)
    const steps: ConnectStep[] = (['ssh', 'auth', 'claude', 'relay', 'login'] as const).map((sid) => ({
      id: sid,
      state: 'pending',
      text: STEP_TEXT[sid]
    }))
    const set = (sid: ConnectStep['id'], patch: Partial<ConnectStep>): void => {
      const i = steps.findIndex((s) => s.id === sid)
      const next: ConnectStep = { ...steps[i]!, ...patch }
      if (patch.hint === undefined && 'hint' in patch) delete next.hint
      steps[i] = next
      this.deps.onProgress(id, steps.map((s) => ({ ...s })))
    }
    const stop = (state: ServerConnState, problem?: string): false => {
      this.setState(id, state, problem)
      return false
    }
    this.setState(id, 'connecting')
    const t = targetOf(entry)

    // 1–2. ssh and the sign-in: the probe is the first command.
    set('ssh', { state: 'running' })
    const probeRun = await this.run(t, remoteCommand(['sh', '-s']), {
      stdin: PROBE_SCRIPT,
      interactive,
      hostId: id,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    const probe = probeRun.code === 0 ? parseProbe(probeRun.stdout) : null
    if (!probe) {
      const failure = classifySshFailure(probeRun.stderr, probeRun.code)
      if (failure === 'hostKeyChanged') {
        const text = hostKeyChangedText(hostPart(entry.target), this.deps.userData)
        set('ssh', { state: 'fail', hint: text })
        return stop('hostKeyChanged', text)
      }
      if (failure === 'authFailed') {
        set('ssh', { state: 'ok' })
        set('auth', { state: 'fail', hint: lastLine(probeRun.stderr) })
        return stop('needsAuth', lastLine(probeRun.stderr))
      }
      const why = lastLine(probeRun.stderr) || (probeRun.code === null ? 'Сервер не ответил' : `ssh: код ${probeRun.code}`)
      set('ssh', { state: 'fail', hint: why })
      return stop('error', why)
    }
    r.probe = probe
    set('ssh', { state: 'ok' })
    set('auth', { state: 'ok' })

    // 3. Claude Code there.
    const claude = claudeStep(probe)
    set('claude', claude)
    if (claude.state === 'fail') return stop('error', claude.text)

    // 4. The relay: installed, updated, then the channel.
    set('relay', { state: 'running' })
    const want = this.deps.manifest?.version ?? this.deps.appVersion
    const need = this.deps.manifest ? needsUpdate(probe.relayVersion, want) : probe.relayVersion ? 'none' : 'install'
    if (need !== 'none') {
      if (need === 'install') set('relay', { state: 'running', text: INSTALLING_TEXT })
      try {
        await this.installBinary(id, entry, probe, interactive)
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        set('relay', { state: 'fail', text: STEP_TEXT.relay, hint: text })
        return stop('error', text)
      }
    }

    const client = this.ensureClient(id, entry)
    try {
      await client.connect(interactive)
    } catch (err) {
      if (isProtoError(err)) {
        r.relayUpdate = 'required'
        set('relay', { state: 'fail', text: STEP_TEXT.relay, hint: RELAY_PROTO_TEXT })
        return stop('error', RELAY_PROTO_TEXT)
      }
      const text = err instanceof Error ? err.message : String(err)
      set('relay', { state: 'fail', text: STEP_TEXT.relay, hint: text })
      return stop(client.state === 'needsAuth' ? 'needsAuth' : client.state === 'hostKeyChanged' ? 'hostKeyChanged' : 'error', text)
    }
    delete r.relayUpdate

    let info: HostInfo | null = null
    try {
      info = await client.call<HostInfo>('host.info', {})
      r.info = { ...info, claudeVersion: probe.claudeVersion }
    } catch {
      // Not needed to work: the checklist goes on.
    }
    if (need === 'update') {
      try {
        const res = await client.call<RestartResult>('relay.restart', { when: 'idle' })
        if (res.busy > 0) r.relayUpdate = 'pending'
      } catch {
        r.relayUpdate = 'pending'
      }
    }
    const relayText = `${STEP_TEXT.relay} ${info?.relay ?? want}`
    const linger = info?.linger ?? probe.linger
    if (r.relayUpdate === 'pending') set('relay', { state: 'warn', text: relayText, hint: RELAY_LATER_TEXT })
    else if (linger === 'no') set('relay', { state: 'warn', text: relayText, hint: lingerText(info?.user ?? probe.user) })
    else set('relay', { state: 'ok', text: relayText })

    // 5. The Claude account there.
    set('login', { state: 'running' })
    await this.refreshAccount(id)
    const account = r.account
    if (account?.loggedIn === true) {
      set('login', { state: 'ok', text: [account.email, account.plan].filter(Boolean).join(' · ') || STEP_TEXT.login })
    } else if (account?.loggedIn === false) {
      set('login', { state: 'warn', text: NOT_LOGGED_IN_TEXT })
    } else set('login', { state: 'warn', text: ACCOUNT_UNKNOWN_TEXT })

    await this.syncSettings(id)
    this.setState(id, 'online')
    return true
  }

  private ensureClient(id: string, entry: ServerEntry): RelayLink {
    const r = this.rt(id)
    if (r.client) return r.client
    const client = this.deps.makeClient(entry)
    r.client = client
    let wasOnline = false
    r.unsubscribe = client.onState((s, problem) => {
      // The checklist sets the state itself while it runs.
      if (r.connecting && s !== 'online') return
      if (s === 'online') {
        if (wasOnline) void this.syncSettings(id)
        wasOnline = true
        if (!r.connecting) this.setState(id, 'online')
        return
      }
      const state: ServerConnState = s === 'connecting' ? 'connecting' : s
      this.setState(id, state, s === 'hostKeyChanged' ? hostKeyChangedText(hostPart(entry.target), this.deps.userData) : problem)
    })
    return client
  }

  private async installBinary(id: string, entry: ServerEntry, probe: ProbeResult, interactive: boolean): Promise<void> {
    const manifest = this.deps.manifest
    if (!manifest) throw new Error(NO_MANIFEST_TEXT)
    if (probe.arch === 'other') throw new Error(claudeStep(probe).text)
    const gz = await ensureLocalRelay(probe.arch, {
      cacheDir: join(this.deps.userData, 'relay'),
      manifest,
      download: this.deps.download ?? httpsDownload,
      ...(this.deps.localRelayDir ? { localDir: this.deps.localRelayDir } : {})
    })
    const body = readFileSync(gz)
    const t = targetOf(entry)
    const put = await this.run(t, remoteCommand(['sh', '-c', INSTALL_SCRIPT(probe.gzip)]), {
      stdin: probe.gzip ? body : gunzipSync(body),
      interactive,
      hostId: id,
      timeoutMs: INSTALL_TIMEOUT_MS
    })
    if (put.code !== 0) throw new Error(lastLine(put.stderr) || `Не удалось поставить посредник (код ${put.code})`)
    const setup = await this.run(t, remoteCommand(['~/.qclod/bin/qclod-relay', 'setup']), {
      interactive,
      hostId: id,
      timeoutMs: PROBE_TIMEOUT_MS
    })
    if (setup.code !== 0) throw new Error(lastLine(setup.stderr) || `Посредник не запустился (код ${setup.code})`)
    this.deps.log?.(`relay installed on ${id}`)
  }

  /** The rules and the auto-answer time go to the relay on every connect and on every change. */
  async syncSettings(id?: string): Promise<void> {
    const ids = id ? [id] : [...this.hosts.keys()]
    await Promise.all(
      ids.map(async (h) => {
        const client = this.hosts.get(h)?.client
        if (!client || client.state !== 'online') return
        try {
          await client.call('rules.sync', { rules: this.deps.rules() })
          await client.call('autonomy.settings', { autoAnswerMs: this.deps.autoAnswerMs() })
        } catch {
          // The next connect sends them again.
        }
      })
    )
  }

  async refreshAccount(id: string): Promise<ServerAuth | null> {
    const r = this.rt(id)
    if (!r.client || r.client.state !== 'online') return null
    try {
      r.account = await r.client.call<ServerAuth>('auth.status', {}, { timeoutMs: 60_000 })
    } catch {
      r.account = { loggedIn: null, claudePath: r.probe?.claudePath ?? null, claudeVersion: r.probe?.claudeVersion ?? null }
    }
    this.changed()
    return r.account
  }

  /** The channel, raised without asking anybody when it is not up. */
  async client(id: string): Promise<RelayLink> {
    const r = this.rt(id)
    if (r.client && r.client.state === 'online') return r.client
    if (r.relayUpdate === 'required') throw new Error(RELAY_PROTO_TEXT)
    if (r.client && r.connecting === null && (r.client.state === 'reconnecting' || r.client.state === 'offline')) {
      // The client tries by itself; one more try now, without questions.
      try {
        await r.client.connect(false)
        return r.client
      } catch {
        // Then the whole checklist.
      }
    }
    if (!(await this.connect(id, false)) || !r.client) {
      throw new Error(r.problem ?? 'Сервер не на связи')
    }
    return r.client
  }

  /** The relay channel if there is one, online or not; nothing is started. */
  existingClient(id: string): RelayLink | null {
    return this.hosts.get(id)?.client ?? null
  }

  probeOf(id: string): ProbeResult | null {
    return this.hosts.get(id)?.probe ?? null
  }

  async listDir(id: string, path: string): Promise<{ path: string; entries: FsEntry[]; truncated: boolean }> {
    const client = await this.client(id)
    return client.call('fs.list', { path })
  }

  openFolder(id: string, path: string): TabState {
    if (!this.deps.store.get(id)) throw new Error('Нет такого сервера')
    this.deps.store.rememberFolder(id, path)
    const tab = this.deps.openTab(path, { hostId: id })
    this.changed()
    return tab
  }

  /** «Обновить посредник»: the new binary at once; the daemon restarts idle, or now with `force`. */
  async updateRelay(id: string, force: boolean): Promise<void> {
    const entry = this.deps.store.get(id)
    if (!entry) return
    const r = this.rt(id)
    let probe = r.probe
    if (!probe) {
      const run = await this.run(targetOf(entry), remoteCommand(['sh', '-s']), {
        stdin: PROBE_SCRIPT,
        interactive: true,
        hostId: id,
        timeoutMs: PROBE_TIMEOUT_MS
      })
      probe = parseProbe(run.stdout) ?? undefined
      if (!probe) throw new Error(lastLine(run.stderr) || 'Сервер не ответил')
      r.probe = probe
    }
    await this.installBinary(id, entry, probe, true)
    const client = this.ensureClient(id, entry)
    if (client.state !== 'online') {
      // An old relay that would not talk to us: the new one starts on the next connect.
      if (r.relayUpdate === 'required') {
        const restart = await this.run(targetOf(entry), remoteCommand(['~/.qclod/bin/qclod-relay', 'setup']), {
          interactive: true,
          hostId: id,
          timeoutMs: PROBE_TIMEOUT_MS
        })
        if (restart.code !== 0) throw new Error(lastLine(restart.stderr) || 'Посредник не перезапустился')
      }
      delete r.relayUpdate
      this.changed()
      await this.connect(id, true)
      return
    }
    const res = await client.call<RestartResult>('relay.restart', { when: force ? 'now' : 'idle' })
    if (res.scheduled && res.busy > 0 && !force) r.relayUpdate = 'pending'
    else delete r.relayUpdate
    this.changed()
  }

  /** On quit: every channel closed; the agents on the servers go on. */
  closeAll(): void {
    for (const r of this.hosts.values()) {
      r.unsubscribe?.()
      r.client?.close()
      r.client = null
    }
  }
}

