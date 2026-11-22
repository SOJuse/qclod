import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostStore, defaultColour } from '@main/ssh/hostStore'
import type { SecretBox } from '@main/ssh/secretBox'

/** Reversible and obviously not plain text: what safeStorage stands for here. */
function fakeBox(available = true): SecretBox {
  return {
    available: () => available,
    seal: (plain) => Buffer.from(plain.split('').reverse().join(''), 'utf8').toString('base64'),
    open: (sealed) => Buffer.from(sealed, 'base64').toString('utf8').split('').reverse().join('')
  }
}

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qclod-hosts-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const manual = { label: 'Дом', target: 'me@home', auth: 'password' as const, fromConfig: false }

describe('HostStore', () => {
  test('пароль в файле не встречается открытым текстом, password(id) возвращает его', () => {
    const store = new HostStore(dir, fakeBox())
    const e = store.save(manual)
    store.setPassword(e.id, 'Секрет-42!')
    const file = readFileSync(join(dir, 'servers.json'), 'utf8')
    expect(file).not.toContain('Секрет-42!')
    expect(file).toContain('sealed')
    expect(store.password(e.id)).toBe('Секрет-42!')
    expect(store.hasPassword(e.id)).toBe(true)
    // A new store reads it back from the file.
    expect(new HostStore(dir, fakeBox()).password(e.id)).toBe('Секрет-42!')
    store.setPassword(e.id, null)
    expect(store.hasPassword(e.id)).toBe(false)
    expect(store.password(e.id)).toBeNull()
  })

  test('I1: смена хоста, порта или ключа сбрасывает сохранённый пароль; та же цель — оставляет', () => {
    const store = new HostStore(dir, fakeBox())
    const e = store.save(manual)
    store.setPassword(e.id, 'pw', 'me@home')
    expect(store.passwordFor(e.id)).toBe('me@home')
    store.save({ ...manual, id: e.id, label: 'Дом 2' })
    expect(store.password(e.id)).toBe('pw')
    expect(store.passwordFor(e.id)).toBe('me@home')
    store.save({ ...manual, id: e.id, target: 'me@elsewhere' })
    expect(store.hasPassword(e.id)).toBe(false)
    expect(store.passwordFor(e.id)).toBeNull()
    for (const change of [{ port: 2222 }, { identityFile: '/k' }]) {
      store.save({ ...manual, id: e.id, target: 'me@elsewhere' })
      store.setPassword(e.id, 'pw')
      store.save({ ...manual, id: e.id, target: 'me@elsewhere', ...change })
      expect(store.hasPassword(e.id)).toBe(false)
    }
    // A password set from the form names no user@host.
    store.setPassword(e.id, 'pw2')
    expect(store.passwordFor(e.id)).toBeNull()
  })

  test('I10: сервер с опасной целью в servers.json не читается, из ~/.ssh/config не берётся', () => {
    writeFileSync(
      join(dir, 'servers.json'),
      JSON.stringify({
        servers: [
          { id: 'a', target: 'me@ok.lan', auth: 'key' },
          { id: 'b', target: "x';touch /tmp/p;'", auth: 'key' },
          { id: 'c', target: '-oProxyCommand=calc', auth: 'key' }
        ]
      })
    )
    const store = new HostStore(dir, fakeBox())
    expect(store.list().map((e) => e.id)).toEqual(['a'])
    store.mergeConfigHosts(['good', 'bad$(id)'])
    expect(store.list().map((e) => e.target)).toEqual(['me@ok.lan', 'good'])
  })

  test('available:false — setPassword ничего не пишет', () => {
    const store = new HostStore(dir, fakeBox(false))
    const e = store.save(manual)
    const before = readFileSync(join(dir, 'servers.json'), 'utf8')
    store.setPassword(e.id, 'pw')
    expect(readFileSync(join(dir, 'servers.json'), 'utf8')).toBe(before)
    expect(store.hasPassword(e.id)).toBe(false)
    expect(store.password(e.id)).toBeNull()
  })

  test('rememberFolder держит 10 и без повторов, новые — в начале', () => {
    const store = new HostStore(dir, fakeBox())
    const e = store.save(manual)
    for (let i = 0; i < 12; i++) store.rememberFolder(e.id, `/p/${i}`)
    store.rememberFolder(e.id, '/p/5')
    const recent = store.list()[0]!.recent
    expect(recent).toHaveLength(10)
    expect(recent[0]).toBe('/p/5')
    expect(new Set(recent).size).toBe(10)
    expect(recent.slice(1, 3)).toEqual(['/p/11', '/p/10'])
  })

  test('mergeConfigHosts не дублирует ручной с тем же target и не трогает ручные', () => {
    const store = new HostStore(dir, fakeBox())
    const mine = store.save({ ...manual, target: 'web' })
    store.mergeConfigHosts(['web', 'db', 'db'])
    const list = store.list()
    expect(list.filter((e) => e.target === 'web')).toHaveLength(1)
    expect(list.find((e) => e.target === 'web')).toMatchObject({ id: mine.id, label: 'Дом', fromConfig: false })
    expect(list.find((e) => e.target === 'db')).toMatchObject({ label: 'db', fromConfig: true, auth: 'key' })
    // Run again: nothing new.
    store.mergeConfigHosts(['web', 'db'])
    expect(store.list()).toHaveLength(2)
  })

  test('сервер из config, пропавший из config, уходит; удалённый не возвращается', () => {
    const store = new HostStore(dir, fakeBox())
    store.mergeConfigHosts(['a', 'b'])
    store.mergeConfigHosts(['a'])
    expect(store.list().map((e) => e.target)).toEqual(['a'])
    store.remove(store.list()[0]!.id)
    store.mergeConfigHosts(['a'])
    expect(store.list()).toEqual([])
  })

  test('save сохраняет id и цвет, новый получает цвет по хешу id', () => {
    const store = new HostStore(dir, fakeBox())
    const e = store.save(manual)
    expect(e.colour).toBe(defaultColour(e.id))
    expect(e.recent).toEqual([])
    const changed = store.save({ ...manual, id: e.id, label: 'Новое', colour: 'rose' })
    expect(changed).toMatchObject({ id: e.id, label: 'Новое', colour: 'rose' })
    expect(store.list()).toHaveLength(1)
  })

  test('испорченный servers.json — пустой список', () => {
    const store = new HostStore(dir, fakeBox())
    store.save(manual)
    writeFileSync(join(dir, 'servers.json'), '{ not json')
    expect(new HostStore(dir, fakeBox()).list()).toEqual([])
  })

  test('defaultColour устойчив и даёт один из шести', () => {
    expect(defaultColour('abc')).toBe(defaultColour('abc'))
    const all = new Set(Array.from({ length: 200 }, (_v, i) => defaultColour(`id${i}`)))
    expect(all.size).toBe(6)
  })
})
