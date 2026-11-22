/**
 * The servers Qclod knows (stage 6): userData/servers.json. Hand-added ones
 * and those from ~/.ssh/config live side by side; a password, when the person
 * asked to keep it, is stored only sealed by the OS (decision 6).
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ServerColour, ServerEntry } from '../../shared/types'
import { SERVER_COLOUR_LIST, isServerColour } from '../../shared/serverColours'
import type { SecretBox } from './secretBox'

export const SERVERS_FILE = 'servers.json'
export const MAX_RECENT_FOLDERS = 10

interface StoredEntry extends ServerEntry {
  /** base64 from safeStorage.encryptString; never the password itself. */
  sealed?: string
}

interface StoredFile {
  servers: StoredEntry[]
  /** Hosts of ~/.ssh/config the person removed: they do not come back. */
  hiddenConfig: string[]
}

export type SaveEntry = Omit<ServerEntry, 'id' | 'colour' | 'recent'> & Partial<Pick<ServerEntry, 'id' | 'colour'>>

export function defaultColour(id: string): ServerColour {
  const n = createHash('sha256').update(id).digest().readUInt32BE(0)
  return SERVER_COLOUR_LIST[n % SERVER_COLOUR_LIST.length]!
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readEntry(raw: unknown): StoredEntry | null {
  if (!isObject(raw)) return null
  const { id, label, target, port, identityFile, auth, colour, recent, fromConfig, sealed } = raw
  if (typeof id !== 'string' || id === '' || typeof target !== 'string' || target === '') return null
  return {
    id,
    label: typeof label === 'string' ? label : target,
    target,
    ...(typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {}),
    ...(typeof identityFile === 'string' && identityFile !== '' ? { identityFile } : {}),
    auth: auth === 'password' ? 'password' : 'key',
    colour: isServerColour(colour) ? colour : defaultColour(id),
    recent: Array.isArray(recent)
      ? recent.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT_FOLDERS)
      : [],
    fromConfig: fromConfig === true,
    ...(typeof sealed === 'string' && sealed !== '' ? { sealed } : {})
  }
}

function publicEntry(e: StoredEntry): ServerEntry {
  const { sealed: _sealed, ...rest } = e
  return { ...rest, recent: [...rest.recent] }
}

export class HostStore {
  private readonly file: string
  private data: StoredFile

  constructor(
    private readonly dir: string,
    private readonly box: SecretBox
  ) {
    this.file = join(dir, SERVERS_FILE)
    this.data = this.load()
  }

  private load(): StoredFile {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return { servers: [], hiddenConfig: [] }
    }
    if (!isObject(parsed)) return { servers: [], hiddenConfig: [] }
    const servers: StoredEntry[] = []
    const ids = new Set<string>()
    for (const raw of Array.isArray(parsed['servers']) ? parsed['servers'] : []) {
      const e = readEntry(raw)
      if (!e || ids.has(e.id)) continue
      ids.add(e.id)
      servers.push(e)
    }
    const hidden = Array.isArray(parsed['hiddenConfig'])
      ? parsed['hiddenConfig'].filter((h): h is string => typeof h === 'string')
      : []
    return { servers, hiddenConfig: hidden }
  }

  private write(): void {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.data }, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private find(id: string): StoredEntry | undefined {
    return this.data.servers.find((e) => e.id === id)
  }

  list(): ServerEntry[] {
    return this.data.servers.map(publicEntry)
  }

  get(id: string): ServerEntry | null {
    const e = this.find(id)
    return e ? publicEntry(e) : null
  }

  save(e: SaveEntry): ServerEntry {
    const existing = e.id !== undefined ? this.find(e.id) : undefined
    const id = existing?.id ?? randomBytes(6).toString('hex')
    const next: StoredEntry = {
      id,
      label: e.label.trim() === '' ? e.target : e.label,
      target: e.target,
      ...(e.port !== undefined ? { port: e.port } : {}),
      ...(e.identityFile ? { identityFile: e.identityFile } : {}),
      auth: e.auth,
      colour: e.colour ?? existing?.colour ?? defaultColour(id),
      recent: existing?.recent ?? [],
      fromConfig: existing ? existing.fromConfig && e.fromConfig : e.fromConfig,
      // A key server keeps no password.
      ...(existing?.sealed && e.auth === 'password' ? { sealed: existing.sealed } : {})
    }
    if (existing) this.data.servers[this.data.servers.indexOf(existing)] = next
    else this.data.servers.push(next)
    this.write()
    return publicEntry(next)
  }

  remove(id: string): void {
    const e = this.find(id)
    if (!e) return
    this.data.servers = this.data.servers.filter((s) => s !== e)
    if (e.fromConfig && !this.data.hiddenConfig.includes(e.target)) this.data.hiddenConfig.push(e.target)
    this.write()
  }

  /** null forgets it. Without the OS's store nothing is written at all. */
  setPassword(id: string, password: string | null): void {
    const e = this.find(id)
    if (!e) return
    if (password === null) {
      if (e.sealed === undefined) return
      delete e.sealed
      this.write()
      return
    }
    if (!this.box.available()) return
    e.sealed = this.box.seal(password)
    this.write()
  }

  password(id: string): string | null {
    const sealed = this.find(id)?.sealed
    if (!sealed || !this.box.available()) return null
    try {
      return this.box.open(sealed)
    } catch {
      return null
    }
  }

  hasPassword(id: string): boolean {
    return this.find(id)?.sealed !== undefined
  }

  canStorePasswords(): boolean {
    return this.box.available()
  }

  rememberFolder(id: string, path: string): void {
    const e = this.find(id)
    if (!e) return
    e.recent = [path, ...e.recent.filter((p) => p !== path)].slice(0, MAX_RECENT_FOLDERS)
    this.write()
  }

  /**
   * The hosts of ~/.ssh/config as servers (fromConfig: true). A hand-added
   * server with the same target stays the only one; a config server the file
   * no longer names goes, unless folders were opened there.
   */
  mergeConfigHosts(names: string[]): void {
    const wanted = new Set(names)
    let changed = false
    const kept = this.data.servers.filter((e) => {
      if (!e.fromConfig || wanted.has(e.target) || e.recent.length > 0 || e.sealed) return true
      changed = true
      return false
    })
    for (const name of wanted) {
      if (this.data.hiddenConfig.includes(name) || kept.some((e) => e.target === name)) continue
      const id = randomBytes(6).toString('hex')
      kept.push({ id, label: name, target: name, auth: 'key', colour: defaultColour(id), recent: [], fromConfig: true })
      changed = true
    }
    if (!changed) return
    this.data.servers = kept
    this.write()
  }
}
