/**
 * The one channel to a server's relay (decision 2): `ssh … -- ~/.qclod/bin/qclod-relay attach`,
 * its stdio carrying the protocol's lines. Tests go straight into the daemon's socket.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { connect } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import type { AskpassServer } from './askpass'
import { remoteCommand, type SshTarget } from './sshArgs'
import { classifySshFailure, ensureControlDir, sshCommand, sshContext, sshEnv, type SpawnFn } from './sshRun'

export interface RelayTransport {
  stdin: Writable
  stdout: Readable
  kill(): void
  onExit(cb: (code: number | null, stderr: string) => void): void
  /** ssh's question is with the person now: the wait for the relay's hello stands still (R4). */
  asking?(): boolean
}

export type TransportFactory = (o: { interactive: boolean }) => RelayTransport

const MAX_STDERR = 64 * 1024

export const ATTACH_COMMAND = remoteCommand(['~/.qclod/bin/qclod-relay', 'attach'])

export function sshTransport(t: SshTarget, hostId: string, askpass: AskpassServer): TransportFactory {
  return ({ interactive }) => {
    const ctx = sshContext()
    ensureControlDir(ctx)
    const ask = askpass.forSpawn(hostId, { interactive, target: t.target })
    const spawn = ctx.spawn ?? (nodeSpawn as SpawnFn)
    const child = spawn(ctx.sshPath, sshCommand(ctx, t, ATTACH_COMMAND, { interactive }), {
      env: sshEnv(ask.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    let exited: { code: number | null } | null = null
    const waiting: Array<(code: number | null, stderr: string) => void> = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (s: string) => {
      if (stderr.length < MAX_STDERR) stderr += s
    })
    // The relay speaking means the sign-in was taken.
    child.stdout?.once('data', () => ask.authed())
    const exit = (code: number | null): void => {
      if (exited) return
      exited = { code }
      ask.done(classifySshFailure(stderr, code) === 'authFailed' ? { authFailed: true } : undefined)
      for (const cb of waiting.splice(0)) cb(code, stderr)
    }
    child.on('close', (code) => exit(code))
    child.on('error', (err) => {
      stderr += err.message
      exit(null)
    })
    child.stdin!.on('error', () => undefined)
    return {
      stdin: child.stdin!,
      stdout: child.stdout!,
      kill: () => {
        child.kill()
      },
      onExit: (cb) => {
        if (exited) cb(exited.code, stderr)
        else waiting.push(cb)
      },
      asking: () => ask.asking()
    }
  }
}

export function socketTransport(path: string): TransportFactory {
  return () => {
    const socket = connect(path)
    let exited = false
    const waiting: Array<(code: number | null, stderr: string) => void> = []
    let why = ''
    socket.on('error', (err) => {
      why = err.message
    })
    socket.on('close', () => {
      if (exited) return
      exited = true
      for (const cb of waiting.splice(0)) cb(null, why)
    })
    return {
      stdin: socket,
      stdout: socket,
      kill: () => {
        socket.destroy()
      },
      onExit: (cb) => {
        if (exited) cb(null, why)
        else waiting.push(cb)
      }
    }
  }
}
