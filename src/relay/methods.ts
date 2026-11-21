import { readFileSync } from 'node:fs'
import { hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import type { SessionHistoryOptions } from '../main/agent/sessionHistory'
import type { HostInfo, RelayMethod } from '../shared/relayProtocol'
import { authStatus } from './auth'
import type { ExtraMethod } from './daemon'
import { badRequest } from './errors'
import { expandHome, indexFiles, listDir, readChunk, statMany, writeUpload } from './fsOps'
import { relayHistory } from './history'
import { SETUP_FILE, type Run, type SetupResult } from './supervisor'

export interface MethodDeps {
  run: Run
  version: string
  claudePath: () => string | null
  home: string
  listSessions: SessionHistoryOptions['listSessions']
}

/** One chunk of an upload: Qclod sends 256 KiB; anything far beyond is no chunk. */
const UPLOAD_CHUNK_MAX = 4 * 1024 * 1024

function text(p: Record<string, unknown>, key: string): string {
  const value = p[key]
  if (typeof value !== 'string' || value === '') throw badRequest(key)
  return value
}

function int(p: Record<string, unknown>, key: string): number {
  const value = p[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw badRequest(key)
  return value
}

function setupResult(root: string): Partial<SetupResult> {
  try {
    return JSON.parse(readFileSync(join(root, SETUP_FILE), 'utf8')) as Partial<SetupResult>
  } catch {
    return {}
  }
}

/** The supervisor the daemon runs under right now, else what setup chose. */
function supervisorNow(saved: Partial<SetupResult>): HostInfo['supervisor'] {
  if (process.env['INVOCATION_ID']) return 'systemd'
  if (process.env['TMUX']) return 'tmux'
  return saved.supervisor === 'systemd' || saved.supervisor === 'tmux' ? saved.supervisor : 'plain'
}

/** The daemon's methods beyond sessions: files, history, account, host (task 13). */
export function relayMethods(deps: MethodDeps): Partial<Record<RelayMethod, ExtraMethod>> {
  const history = relayHistory(deps.listSessions)
  return {
    'host.info': async (_p, { daemon }): Promise<HostInfo> => {
      const saved = setupResult(daemon.paths.root)
      return {
        hostname: hostname(),
        user: userInfo().username,
        home: deps.home,
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        relay: deps.version,
        supervisor: supervisorNow(saved),
        linger: saved.linger === 'yes' || saved.linger === 'no' ? saved.linger : 'unknown'
      }
    },
    'auth.status': async () => authStatus(deps.run, deps.claudePath()),
    'history.list': async (p) => history.list(expandHome(text(p, 'cwd'), deps.home)),
    'fs.list': async (p) => listDir(text(p, 'path'), deps.home),
    'fs.stat': async (p) => {
      if (!Array.isArray(p['paths'])) throw badRequest('paths')
      return statMany(text(p, 'cwd'), p['paths'] as string[], deps.home)
    },
    'fs.read': async (p) => readChunk(text(p, 'path'), int(p, 'offset'), int(p, 'length'), deps.home),
    'fs.index': async (p) => indexFiles(expandHome(text(p, 'root'), deps.home), int(p, 'limit')),
    'fs.upload': async (p, { daemon }) => {
      const data = p['dataBase64']
      if (typeof data !== 'string' || data.length > (UPLOAD_CHUNK_MAX / 3) * 4 + 4) throw badRequest('dataBase64')
      return writeUpload(
        daemon.paths.uploads,
        text(p, 's'),
        text(p, 'name'),
        int(p, 'offset'),
        Buffer.from(data, 'base64'),
        p['final'] === true
      )
    }
  }
}
