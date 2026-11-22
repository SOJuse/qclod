import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = resolve(__dirname, '../..')
const require = createRequire(import.meta.url)
const fuses = require(join(root, 'scripts', 'fuses.cjs')) as {
  FUSE: Record<string, number>
  SENTINEL: Buffer
  readFuses(buf: Buffer): { start: number; fuses: string[] }
  flipFuses(buf: Buffer, wanted?: Record<number, boolean>): Buffer
  fuseBinaryPath(platform: string, appOutDir: string, productFilename: string, executableName?: string): string
}

/** A binary as Electron 33 ships it: every fuse at its default. */
function binary(bytes = '10110001'): Buffer {
  return Buffer.concat([Buffer.from('MZ...head...'), fuses.SENTINEL, Buffer.from([1, bytes.length]), Buffer.from(bytes, 'ascii'), Buffer.from('...tail')])
}

describe('фьюзы Electron (I8)', () => {
  test('сборка выключает инспектор из командной строки и NODE_OPTIONS, RunAsNode оставляет', () => {
    const out = fuses.readFuses(fuses.flipFuses(binary())).fuses
    expect(out[fuses.FUSE.EnableNodeCliInspectArguments!]).toBe('0')
    expect(out[fuses.FUSE.EnableNodeOptionsEnvironmentVariable!]).toBe('0')
    // The Mac's askpass.sh runs the app with ELECTRON_RUN_AS_NODE=1.
    expect(out[fuses.FUSE.RunAsNode!]).toBe('1')
    // The rest as they were.
    expect(out.join('')).toBe('10000001')
  })

  test('нет фьюзов или фьюз удалён — сборка падает, а не молчит', () => {
    expect(() => fuses.flipFuses(Buffer.from('no fuses here'))).toThrow()
    expect(() => fuses.flipFuses(binary('101r0001'))).toThrow(/удалён/)
  })

  test('electron-builder вызывает его в afterPack, до подписи', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')
    // One afterPack for the build: build/afterPack.cjs sets the fuses, then signs on a Mac.
    expect(yml).toMatch(/^afterPack: build\/afterPack\.cjs$/m)
    const hook = readFileSync(join(root, 'build', 'afterPack.cjs'), 'utf8')
    expect(hook).toContain("require('../scripts/fuses.cjs')")
    expect(hook.indexOf('fuses.afterPack(context)')).toBeGreaterThan(-1)
    expect(hook.indexOf('fuses.afterPack(context)')).toBeLessThan(hook.indexOf('codesign'))

    expect(typeof (require(join(root, 'scripts', 'fuses.cjs')) as { afterPack: unknown }).afterPack).toBe('function')
  })

  test('файл фьюзов: exe на Windows, Electron Framework внутри .app на Mac', () => {
    expect(fuses.fuseBinaryPath('win32', 'D', 'Qclod').replace(/\\/g, '/')).toBe('D/Qclod.exe')
    expect(fuses.fuseBinaryPath('darwin', 'D', 'Qclod').replace(/\\/g, '/')).toBe(
      'D/Qclod.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'
    )
  })

  const exe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  test.skipIf(!existsSync(exe))('в настоящем electron.exe фьюзы находятся и меняются', () => {
    const real = readFileSync(exe)
    const before = fuses.readFuses(real).fuses
    expect(before.length).toBeGreaterThanOrEqual(4)
    const after = fuses.readFuses(fuses.flipFuses(real)).fuses
    expect(after[3]).toBe('0')
    expect(after[2]).toBe('0')
    expect(after[0]).toBe('1')
  })
})
