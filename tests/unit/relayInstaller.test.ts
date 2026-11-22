import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INSTALL_SCRIPT,
  RELAY_MISSING_TEXT,
  ensureLocalRelay,
  compareVersions,
  needsUpdate,
  relayAssetUrl,
  type RelayManifest
} from '@main/ssh/relayInstaller'

const BODY = Buffer.from('relay-binary-gz')
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const NAME = 'qclod-relay-1.0.0-linux-x64.gz'

function manifest(hash = sha(BODY)): RelayManifest {
  return {
    version: '1.0.0',
    assets: {
      x64: { name: NAME, sha256: hash, size: BODY.length },
      arm64: { name: 'qclod-relay-1.0.0-linux-arm64.gz', sha256: hash, size: BODY.length }
    }
  }
}

let cacheDir = ''
beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'qclod-relaycache-'))
})
afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true })
})

describe('ensureLocalRelay', () => {
  test('скачивает по адресу релиза, верный хеш — путь из кеша без повторной загрузки', async () => {
    const download = vi.fn(async (_url: string, dest: string) => writeFileSync(dest, BODY))
    const first = await ensureLocalRelay('x64', { cacheDir, manifest: manifest(), download })
    expect(first).toBe(join(cacheDir, NAME))
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0]![0]).toBe(
      'https://github.com/SOJuse/qclod/releases/download/v1.0.0/qclod-relay-1.0.0-linux-x64.gz'
    )
    const second = await ensureLocalRelay('x64', { cacheDir, manifest: manifest(), download })
    expect(second).toBe(first)
    expect(download).toHaveBeenCalledTimes(1)
  })

  test('неверный хеш — файл удалён и ошибка', async () => {
    const download = vi.fn(async (_url: string, dest: string) => writeFileSync(dest, Buffer.from('tampered-bytes!')))
    await expect(ensureLocalRelay('x64', { cacheDir, manifest: manifest(), download })).rejects.toThrow(
      'Скачанный посредник не совпал с контрольной суммой'
    )
    expect(existsSync(join(cacheDir, NAME))).toBe(false)
    expect(existsSync(join(cacheDir, NAME + '.part'))).toBe(false)
  })

  test('файл из артефактов в userData/relay ставится без сети', async () => {
    writeFileSync(join(cacheDir, NAME), BODY)
    const download = vi.fn()
    expect(await ensureLocalRelay('x64', { cacheDir, manifest: manifest(), download })).toBe(join(cacheDir, NAME))
    expect(download).not.toHaveBeenCalled()
  })

  test('download бросил 404 — ошибка с текстом RELAY_MISSING_TEXT', async () => {
    const download = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 404'), { status: 404 })
    })
    await expect(ensureLocalRelay('x64', { cacheDir, manifest: manifest(), download })).rejects.toThrow(
      RELAY_MISSING_TEXT(cacheDir, NAME)
    )
    expect(RELAY_MISSING_TEXT('C:\\R', NAME)).toBe(
      'Не удалось скачать посредник Qclod 1.0.0. Для сборки до выпуска положите файл ' +
        'qclod-relay-1.0.0-linux-x64.gz из артефактов CI в папку C:\\R и нажмите «Проверить снова».'
    )
  })

  test('испорченный файл в кеше заменяется скачанным', async () => {
    writeFileSync(join(cacheDir, NAME), Buffer.from('old'))
    const download = vi.fn(async (_url: string, dest: string) => writeFileSync(dest, BODY))
    expect(await ensureLocalRelay('x64', { cacheDir, manifest: manifest(), download })).toBe(join(cacheDir, NAME))
    expect(download).toHaveBeenCalledTimes(1)
  })

  test('localDir тестовой сборки заменяет загрузку', async () => {
    const local = mkdtempSync(join(tmpdir(), 'qclod-relaylocal-'))
    writeFileSync(join(local, NAME), Buffer.from('dev build'))
    const download = vi.fn()
    expect(await ensureLocalRelay('x64', { cacheDir, manifest: manifest(), download, localDir: local })).toBe(
      join(local, NAME)
    )
    expect(download).not.toHaveBeenCalled()
    rmSync(local, { recursive: true, force: true })
  })
})

describe('скрипт установки и версии', () => {
  test('INSTALL_SCRIPT(false) не содержит gzip, (true) распаковывает на сервере', () => {
    expect(INSTALL_SCRIPT(false)).not.toContain('gzip')
    expect(INSTALL_SCRIPT(true)).toContain('gzip -dc')
    for (const s of [INSTALL_SCRIPT(true), INSTALL_SCRIPT(false)]) {
      expect(s).toContain('umask 077')
      expect(s).toContain('mkdir -p "$HOME/.qclod/bin"')
      expect(s).toContain('chmod 700')
      expect(s.indexOf('.new" version')).toBeLessThan(s.indexOf('mv -f'))
      expect(s).toContain('"$HOME/.qclod/bin/qclod-relay"')
    }
  })

  test('needsUpdate', () => {
    expect(needsUpdate(null, '1.0.0')).toBe('install')
    expect(needsUpdate('1.0.0', '1.0.1')).toBe('update')
    expect(needsUpdate('1.0.1', '1.0.1')).toBe('none')
  })

  test('I7: ПК и Mac разных версий — новее не откатывается, старее обновляется (semver)', () => {
    // The Mac has 1.0.2 and put its relay there; this PC is 1.0.1.
    expect(needsUpdate('1.0.2', '1.0.1')).toBe('none')
    expect(needsUpdate('1.0.1', '1.0.2')).toBe('update')
    expect(needsUpdate('1.0.10', '1.0.9')).toBe('none')
    expect(needsUpdate('1.0.0-rc.1', '1.0.0')).toBe('update')
    expect(needsUpdate('1.0.0', '1.0.0-rc.2')).toBe('none')
    expect(needsUpdate('1.0.0-rc.2', '1.0.0-rc.10')).toBe('update')
    expect(needsUpdate('1.0.0-rc.10', '1.0.0-rc.2')).toBe('none')
    expect(needsUpdate('1.0.0-alpha', '1.0.0-alpha.1')).toBe('update')
    // Not a version at all: replaced unless it is ours.
    expect(needsUpdate('dev', '1.0.0')).toBe('update')
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0)
  })

  test('relayAssetUrl', () => {
    expect(relayAssetUrl('1.2.3', 'a.gz')).toBe('https://github.com/SOJuse/qclod/releases/download/v1.2.3/a.gz')
  })
})
