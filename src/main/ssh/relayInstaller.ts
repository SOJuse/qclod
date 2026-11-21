/**
 * The relay binary (decision 3): Qclod fetches `qclod-relay-<ver>-linux-<arch>.gz`
 * from its own GitHub release into userData/relay/, checks the SHA-256 of the
 * manifest built into it, and pipes it to the server over ssh. The server needs
 * no internet. A file with the manifest's name and hash already in the folder is
 * taken without the network: that is how a build before its tag installs one
 * (сверка F3).
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface RelayAsset {
  name: string
  sha256: string
  size: number
}

export interface RelayManifest {
  version: string
  assets: Record<'x64' | 'arm64', RelayAsset>
}

export function relayAssetUrl(version: string, name: string): string {
  return `https://github.com/SOJuse/qclod/releases/download/v${version}/${name}`
}

export function RELAY_MISSING_TEXT(cacheDir: string, name: string): string {
  const version = /^qclod-relay-(.+)-linux-[^-]+\.gz$/.exec(name)?.[1] ?? '?'
  return (
    `Не удалось скачать посредник Qclod ${version}. Для сборки до выпуска положите файл ${name} ` +
    `из артефактов CI в папку ${cacheDir} и нажмите «Проверить снова».`
  )
}

export const CHECKSUM_TEXT = 'Скачанный посредник не совпал с контрольной суммой'

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function matches(file: string, asset: RelayAsset): Promise<boolean> {
  try {
    if (!existsSync(file) || statSync(file).size !== asset.size) return false
    return (await sha256Of(file)) === asset.sha256.toLowerCase()
  } catch {
    return false
  }
}

function isNotFound(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  return status === 404 || (err instanceof Error && /\b404\b/.test(err.message))
}

/** The path of the verified .gz. */
export async function ensureLocalRelay(
  arch: 'x64' | 'arm64',
  deps: {
    cacheDir: string
    manifest: RelayManifest
    download: (url: string, dest: string) => Promise<void>
    /** Test builds only (QCLOD_RELAY_BINARY_DIR): a folder with the binaries just built. */
    localDir?: string
  }
): Promise<string> {
  const asset = deps.manifest.assets[arch]
  if (deps.localDir) {
    const local = join(deps.localDir, asset.name)
    if (!existsSync(local)) throw new Error(`Нет файла ${local}`)
    return local
  }
  mkdirSync(deps.cacheDir, { recursive: true })
  const file = join(deps.cacheDir, asset.name)
  if (await matches(file, asset)) return file
  rmSync(file, { force: true })

  const part = `${file}.part`
  rmSync(part, { force: true })
  try {
    await deps.download(relayAssetUrl(deps.manifest.version, asset.name), part)
  } catch (err) {
    rmSync(part, { force: true })
    if (isNotFound(err)) throw new Error(RELAY_MISSING_TEXT(deps.cacheDir, asset.name))
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(`${RELAY_MISSING_TEXT(deps.cacheDir, asset.name)} (${why})`)
  }
  if (!(await matches(part, asset))) {
    rmSync(part, { force: true })
    throw new Error(CHECKSUM_TEXT)
  }
  renameSync(part, file)
  return file
}

/** fetch with redirects (GitHub sends release files elsewhere), into `dest`. */
export async function httpsDownload(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest))
}

const BIN = '"$HOME/.qclod/bin/qclod-relay"'
const NEW = '"$HOME/.qclod/bin/qclod-relay.new"'

/**
 * Run as `sh -c` with the binary on stdin: gzip'd when the server has gzip,
 * already unpacked by Qclod when not. The new file must answer `version`
 * before it replaces the old one.
 */
export const INSTALL_SCRIPT = (gzip: boolean): string =>
  [
    'set -e',
    'umask 077',
    'mkdir -p "$HOME/.qclod/bin"',
    gzip ? `gzip -dc > ${NEW}` : `cat > ${NEW}`,
    `chmod 700 ${NEW}`,
    `${NEW} version`,
    `mv -f ${NEW} ${BIN}`
  ].join('\n')

/** `1.2.3` or `1.2.3-rc.1`: the parts semver compares; null for anything else. */
function parseVersion(v: string): { nums: [number, number, number]; pre: string[] } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Semver order: <0 when a is older, 0 the same, >0 newer; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!
  // A release is newer than any of its pre-releases.
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/**
 * What the server's relay needs (I7): only an older one is replaced. A newer
 * one — put there by a newer Qclod on the other machine — stays, so a PC and
 * a Mac of different versions do not take turns reinstalling it. Whether it
 * still talks to this Qclod is the hello's to say (proto).
 */
export function needsUpdate(installed: string | null, app: string): 'none' | 'install' | 'update' {
  if (installed === null) return 'install'
  const order = compareVersions(installed, app)
  if (order === null) return installed === app ? 'none' : 'update'
  return order >= 0 ? 'none' : 'update'
}
