import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { APP_ID } from '../../src/shared/appId'

const root = resolve(__dirname, '../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const yml = readFileSync(resolve(root, 'electron-builder.yml'), 'utf8')

describe('сборка', () => {
  test('автор — SOJuse, почты нет', () => {
    expect(pkg.author).toBe('SOJuse')
    expect(pkg.repository).toEqual({ type: 'git', url: 'https://github.com/SOJuse/qclod.git' })
    expect(yml).toMatch(/^appId: io\.github\.sojuse\.qclod$/m)
    expect(yml).toMatch(/^copyright: Copyright © 2026 SOJuse$/m)
    expect(JSON.stringify(pkg) + yml).not.toMatch(/sojuse|@[a-z0-9-]+\.[a-z]{2,}/i)
  })
  test('appId приложения совпадает с установщиком', () => {
    expect(yml).toContain(`appId: ${APP_ID}`)
  })
  test('обновления берутся из публичных релизов SOJuse/qclod', () => {
    expect(yml).toMatch(/^publish:\n  provider: github\n  owner: SOJuse\n  repo: qclod\n  releaseType: release$/m)
  })
})

describe('документы', () => {
  test('README для друзей: ссылка на релизы, про SmartScreen, без почты', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    expect(readme).toContain('Выполнить в любом случае')
    expect(readme).toContain('SOJuse/qclod/releases')
    expect(readme).not.toMatch(/sojuse/i)
    expect(readme).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
  })
  test('чек-лист описывает вход через claude auth login', () => {
    const list = readFileSync(resolve(root, 'docs/superpowers/checklists/release-smoke.md'), 'utf8')
    expect(list).toContain('claude auth login')
    expect(list).not.toContain('Открыть терминал')
  })
})
