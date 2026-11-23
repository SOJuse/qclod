// 1.0.1: vpn — the service made with Electron's pieces, and what the window may ask of it.
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { app, ipcMain, shell } from 'electron'
import { CHANNELS } from '../../shared/channels'
import type { SecretBox } from '../ssh/secretBox'
import { sanitizeVpnLink, sanitizeVpnOptions } from '../tabs/sanitize'
import { windowsRegistry, type Registry } from './systemProxy'
import { VpnService, type ClientProcess } from './vpnService'

const BINARY = process.platform === 'win32' ? 'hysteria.exe' : 'hysteria'

export function hysteriaPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'hysteria', BINARY)
    : join(app.getAppPath(), 'build', 'vendor', 'hysteria', BINARY)
}

/** Ends `pid` only if it is a hysteria client (a reused pid of someone else's stays). */
function killOrphan(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
        if (!err && String(out).toLowerCase().startsWith(`"${BINARY}"`)) {
          execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true }, () => resolve())
        } else resolve()
      })
    } else {
      execFile('ps', ['-p', String(pid), '-o', 'comm='], (err, out) => {
        if (!err && String(out).trim().endsWith(BINARY)) {
          try {
            process.kill(pid)
          } catch {
            /* gone */
          }
        }
        resolve()
      })
    }
  })
}

/** A test build never touches the real system proxy: an in-memory registry stands in. */
function memoryRegistry(): Registry {
  const values = new Map<string, string | number>()
  return {
    read: async (n) => values.get(n) ?? null,
    write: async (n, v) => void values.set(n, v),
    remove: async (n) => void values.delete(n),
    notify: async () => undefined
  }
}

/** The e2e client: says «connected» without a network; QCLOD_FAKE_VPN=fail exits instead. */
function fakeClient(mode: string): ClientProcess {
  const lines: Array<(l: string) => void> = []
  const exits: Array<(c: number | null) => void> = []
  let killed = false
  setTimeout(() => {
    if (killed) return
    if (mode === 'fail') {
      lines.forEach((cb) => cb('FATAL\tfailed to connect\t{"error": "fake failure"}'))
      exits.forEach((cb) => cb(1))
    } else lines.forEach((cb) => cb('INFO\tconnected to server\t{"addr": "fake"}'))
  }, 150)
  return {
    pid: undefined,
    onLine: (cb) => lines.push(cb),
    onExit: (cb) => exits.push(cb),
    kill: () => {
      killed = true
    }
  }
}

export function createVpnService(opts: {
  dir: string
  box: SecretBox
  send(view: unknown): void
  log(message: string): void
}): VpnService {
  const fake = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_FAKE_VPN'] : undefined
  return new VpnService({
    dir: opts.dir,
    box: opts.box,
    registry: __QCLOD_TEST_SEAMS__ ? memoryRegistry() : process.platform === 'win32' ? windowsRegistry() : null,
    binaryPath: hysteriaPath,
    ...(fake ? { spawnClient: () => fakeClient(fake), probe: async () => 42 } : {}),
    killOrphan,
    onChange: (v) => opts.send(v),
    log: opts.log
  })
}

export function registerVpnIpc(vpn: VpnService): void {
  ipcMain.handle(CHANNELS.vpnGet, () => vpn.view())
  ipcMain.handle(CHANNELS.vpnSetLink, (_e, raw: unknown) => {
    const link = sanitizeVpnLink(raw)
    if (link === null) throw new Error('Неверная ссылка')
    return vpn.setLink(link)
  })
  ipcMain.handle(CHANNELS.vpnSetOptions, (_e, raw: unknown) => vpn.setOptions(sanitizeVpnOptions(raw)))
  ipcMain.handle(CHANNELS.vpnConnect, () => vpn.connect())
  ipcMain.handle(CHANNELS.vpnTelegram, async () => {
    const url = vpn.telegramUrl()
    if (__QCLOD_TEST_SEAMS__) {
      // e2e reads what would have been opened; a test build never launches Telegram.
      const g = globalThis as { __qclodTelegramOpens?: string[] }
      ;(g.__qclodTelegramOpens ??= []).push(url)
      return url
    }
    await shell.openExternal(url)
    return url
  })
  ipcMain.handle(CHANNELS.vpnDisconnect, () => vpn.disconnect())
}
