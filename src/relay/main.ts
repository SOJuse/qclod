/**
 * qclod-relay: Qclod's relay on a Linux server (stage 6). One binary (Node 22
 * SEA), four commands:
 *   version — {"version","proto"} as JSON;
 *   daemon  — the daemon on ~/.qclod/run/relay.sock (systemd, tmux or plain);
 *   attach  — stdio ↔ the daemon's socket, starting the daemon if need be;
 *   setup   — installs the supervisor (systemd user unit, else tmux) and checks Linger.
 *
 * Nothing here may reach Electron or the renderer (tests/unit/relayBoundary.test.ts).
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { isSea } from 'node:sea'
import { RELAY_PROTO } from '../shared/relayProtocol'
import { runAttach } from './attach'
import { RelayDaemon } from './daemon'
import { findClaude, loginShellPath, mergePath } from './env'
import { createLog } from './log'
import { relayMethods } from './methods'
import { BINARY_NAME, relayPaths } from './paths'
import { relayDriverFactory, relayListSessions } from './sdk'
import { UNIT_NAME, setup, startCommand, type Run } from './supervisor'

declare const __QCLOD_RELAY_VERSION__: string

const VERSION = typeof __QCLOD_RELAY_VERSION__ === 'string' ? __QCLOD_RELAY_VERSION__ : '0.0.0-dev'

function paths() {
  // A test build of the relay keeps everything under QCLOD_RELAY_HOME.
  const override = __QCLOD_TEST_SEAMS__ ? process.env['QCLOD_RELAY_HOME'] : undefined
  return relayPaths(homedir(), process.platform, override || undefined)
}

const run: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })

/**
 * How this very program is started again: the SEA binary alone, or node with
 * the bundle. Asked of node:sea, not read from argv[1]: that one is the path
 * as the caller spelled it, which need not match execPath.
 */
function self(): { cmd: string; args: string[] } {
  const script = process.argv[1]
  return isSea() || !script ? { cmd: process.execPath, args: [] } : { cmd: process.execPath, args: [script] }
}

/** The command line after the program: argv[2] on in both SEA (argv[1] = exe) and node. */
function command(): string[] {
  return process.argv.slice(2)
}

function spawnDetached(cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => undefined)
  child.unref()
}

/** The next daemon, outside this process's session: tmux or a plain detached one. */
function spawnDaemon(): void {
  const { cmd, args } = self()
  spawnDetached(cmd, [...args, 'daemon'])
}

async function daemon(): Promise<number> {
  const p = paths()
  const log = createLog(p.logs)
  const home = homedir()
  const fromShell = await loginShellPath({ home })
  const PATH = mergePath(process.env['PATH'] ?? '', fromShell, home)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH }
  const supervised = typeof process.env['INVOCATION_ID'] === 'string'
  // A test build on the fake SDK needs no claude on the machine (the CI runner has none).
  const fakeClaude = __QCLOD_TEST_SEAMS__ && process.env['QCLOD_FAKE_SDK'] ? 'claude' : null
  const claudePath = (): string | null => findClaude(PATH, home) ?? fakeClaude
  const binary = join(p.bin, BINARY_NAME)
  const d = new RelayDaemon({
    paths: p,
    version: VERSION,
    createDriver: relayDriverFactory(),
    claudePath,
    env,
    log,
    supervised,
    spawnSuccessor: spawnDaemon,
    home,
    methods: relayMethods({ run, version: VERSION, claudePath, home, listSessions: relayListSessions }),
    // The file on disk may be newer than the running daemon: the update the client waits for.
    binaryVersion: () =>
      new Promise((resolve) => {
        if (!existsSync(binary)) {
          resolve(VERSION)
          return
        }
        execFile(binary, ['version'], { timeout: 5000 }, (error, stdout) => {
          try {
            resolve(error ? VERSION : String((JSON.parse(String(stdout)) as { version?: unknown }).version ?? VERSION))
          } catch {
            resolve(VERSION)
          }
        })
      })
  })
  if (!(await d.start())) return 0
  const quit = (): void => {
    void d.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', quit)
  process.on('SIGINT', quit)
  process.on('SIGHUP', () => undefined)
  process.on('uncaughtException', (error) => log.error('необработанная ошибка', error))
  process.on('unhandledRejection', (error) => log.error('необработанный отказ', error))
  // Lives until a signal or a restart: never on its own (decision 13).
  return await new Promise<number>(() => undefined)
}

async function attach(): Promise<number> {
  const p = paths()
  const unit = join(homedir(), '.config', 'systemd', 'user', `${UNIT_NAME}.service`)
  return runAttach(p, { stdin: process.stdin, stdout: process.stdout }, async () => {
    if (existsSync(unit)) {
      const { cmd, args } = startCommand('systemd')
      const { code } = await run(cmd, args)
      if (code === 0) return
    }
    spawnDaemon()
  })
}

async function main(): Promise<number> {
  const [cmd] = command()
  switch (cmd) {
    case 'version':
      process.stdout.write(JSON.stringify({ version: VERSION, proto: RELAY_PROTO }) + '\n')
      return 0
    case 'daemon':
      return daemon()
    case 'attach':
      return attach()
    case 'setup': {
      const result = await setup(run, paths(), userInfo().username)
      process.stdout.write(JSON.stringify(result) + '\n')
      return 0
    }
    default:
      process.stderr.write('qclod-relay: version | daemon | attach | setup\n')
      return 2
  }
}

main().then(
  (code) => {
    // attach and version end here; the daemon never resolves.
    process.exitCode = code
    if (command()[0] === 'attach') process.exit(code)
  },
  (error: unknown) => {
    process.stderr.write(`qclod-relay: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
)
