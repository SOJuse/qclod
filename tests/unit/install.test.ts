import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstallSlot, runInstaller, type InstallHandle } from '@main/setup/install'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** parent.js starts a grandchild that idles, prints its pid, then idles itself. */
function treeScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-install-'))
  writeFileSync(join(dir, 'child.js'), 'setInterval(() => {}, 1000)\n')
  writeFileSync(
    join(dir, 'parent.js'),
    [
      "const { spawn } = require('node:child_process')",
      "const c = spawn(process.execPath, [require('node:path').join(__dirname, 'child.js')], { stdio: 'ignore' })",
      "console.log('CHILD ' + c.pid)",
      'setInterval(() => {}, 1000)'
    ].join('\n')
  )
  return join(dir, 'parent.js')
}

const spawned: number[] = []
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

/** Starts the tree and resolves once the grandchild pid has been printed. */
async function startTree(): Promise<{
  handle: InstallHandle
  childPid: number
  done: Promise<boolean>
  doneCalls: () => number
}> {
  let calls = 0
  let resolveDone!: (ok: boolean) => void
  const done = new Promise<boolean>((r) => (resolveDone = r))
  let resolvePid!: (pid: number) => void
  const pidSeen = new Promise<number>((r) => (resolvePid = r))
  const handle = runInstaller(
    'node',
    [treeScript()],
    (line) => {
      const m = /^CHILD (\d+)$/.exec(line)
      if (m) resolvePid(Number(m[1]))
    },
    (ok) => {
      calls++
      resolveDone(ok)
    }
  )
  const childPid = await pidSeen
  spawned.push(childPid)
  return { handle, childPid, done, doneCalls: () => calls }
}

describe('runInstaller', () => {
  test('отмена убивает и внука, а не только cmd.exe', async () => {
    const { handle, childPid, done } = await startTree()
    expect(alive(childPid)).toBe(true)

    handle.cancel()

    expect(await done).toBe(false)
    await expect.poll(() => alive(childPid), { timeout: 10000 }).toBe(false)
  }, 30000)

  test('onDone вызывается один раз', async () => {
    const { handle, done, doneCalls } = await startTree()
    handle.cancel()
    await done
    await new Promise((r) => setTimeout(r, 500))
    expect(doneCalls()).toBe(1)
  }, 30000)
})

describe('InstallSlot', () => {
  function fakeInstall(): { begin: (done: (ok: boolean) => void) => InstallHandle; finish: (ok: boolean) => void } {
    let doneFn: ((ok: boolean) => void) | null = null
    return {
      begin: (done) => {
        doneFn = done
        return { cancel: () => undefined }
      },
      finish: (ok) => doneFn?.(ok)
    }
  }

  test('слот не даёт начать вторую установку, пока идёт первая', async () => {
    const slot = new InstallSlot()
    const first = fakeInstall()
    const p = slot.start(first.begin)
    expect(p).toBeInstanceOf(Promise)
    expect(slot.busy).toBe(true)
    expect(slot.start(fakeInstall().begin)).toBeNull()

    first.finish(true)
    expect(await p).toBe(true)
    expect(slot.busy).toBe(false)
  })

  test('после отмены слот занят, пока процесс не умер, потом свободен', async () => {
    const slot = new InstallSlot()
    const first = fakeInstall()
    const p = slot.start(first.begin)

    slot.cancel()
    expect(slot.busy).toBe(true)
    expect(slot.start(fakeInstall().begin)).toBeNull()

    first.finish(false)
    expect(await p).toBe(false)
    expect(slot.busy).toBe(false)
    expect(slot.start(fakeInstall().begin)).toBeInstanceOf(Promise)
  })

  test('с настоящим деревом: отмена и тут же вторая установка — вторая ждёт, пока внук не умрёт', async () => {
    const slot = new InstallSlot()
    let childPid = 0
    let resolvePid!: (pid: number) => void
    const pidSeen = new Promise<number>((r) => (resolvePid = r))
    const p = slot.start((done) =>
      runInstaller(
        'node',
        [treeScript()],
        (line) => {
          const m = /^CHILD (\d+)$/.exec(line)
          if (m) resolvePid(Number(m[1]))
        },
        done
      )
    )!
    childPid = await pidSeen
    spawned.push(childPid)

    slot.cancel()
    expect(slot.start(fakeInstall().begin)).toBeNull()
    await p
    expect(slot.busy).toBe(false)
    await expect.poll(() => alive(childPid), { timeout: 10000 }).toBe(false)
    expect(slot.start(fakeInstall().begin)).toBeInstanceOf(Promise)
  }, 30000)

  test('отмена до того, как begin вернул ручку, доходит до неё', async () => {
    const slot = new InstallSlot()
    let cancelled = false
    let finish!: () => void
    let doneFn!: (ok: boolean) => void
    const p = slot.start(
      (done) =>
        new Promise<InstallHandle>((resolve) => {
          doneFn = done
          finish = () => resolve({ cancel: () => { cancelled = true; doneFn(false) } })
        })
    )!
    slot.cancel()
    finish()
    expect(await p).toBe(false)
    expect(cancelled).toBe(true)
  })

  test('begin, который бросает, освобождает слот', async () => {
    const slot = new InstallSlot()
    const p = slot.start(() => {
      throw new Error('boom')
    })!
    expect(await p).toBe(false)
    expect(slot.busy).toBe(false)
  })
})
