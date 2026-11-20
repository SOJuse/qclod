import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { APP_ID } from '../../src/shared/appId'
import { TRAY_GLYPH } from '../../src/main/brand/trayGlyph'

const root = resolve(__dirname, '../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const yml = readFileSync(resolve(root, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')

describe('сборка', () => {
  test('автор — SOJuse, почты нет', () => {
    expect(pkg.author).toBe('SOJuse')
    expect(pkg.repository).toEqual({ type: 'git', url: 'https://github.com/SOJuse/qclod.git' })
    expect(yml).toMatch(/^appId: io\.github\.sojuse\.qclod$/m)
    expect(yml).toMatch(/^copyright: Copyright © 2026 SOJuse$/m)
    expect(JSON.stringify(pkg) + yml).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
  })
  test('appId приложения совпадает с установщиком', () => {
    expect(yml).toContain(`appId: ${APP_ID}`)
  })
  test('обновления берутся из публичных релизов SOJuse/qclod', () => {
    expect(yml).toMatch(/^publish:\n  provider: github\n  owner: SOJuse\n  repo: qclod\n  releaseType: release$/m)
  })
})

describe('иконка', () => {
  test('electron-builder берёт ICO для Windows и ICNS для macOS', () => {
    const win = yml.split(/^win:\n/m)[1]?.split(/^\S/m)[0] ?? ''
    expect(win).toContain('  icon: build/icon.ico\n')
    expect(yml).toMatch(/^mac:\n  icon: build\/icon\.icns$/m)
  })
  test('файлы иконки и исходные SVG на месте', () => {
    for (const file of [
      'build/icon.png', 'build/icon.ico', 'build/icon.icns',
      'build/brand/qclod.svg', 'build/brand/tray.svg', 'src/renderer/assets/mark.svg',
      'src/main/brand/trayGlyph.ts'
    ]) {
      expect(existsSync(resolve(root, file)), file).toBe(true)
    }
  })
  test('в build/icon.ico семь записей', () => {
    const ico = readFileSync(resolve(root, 'build/icon.ico'))
    expect(ico.readUInt16LE(4)).toBe(7)
  })
  test('маска трея: size×size байт после base64', () => {
    for (const size of [16, 24, 32] as const) {
      expect(Buffer.from(TRAY_GLYPH[size], 'base64').length).toBe(size * size)
    }
  })
})

describe('документы', () => {
  test('README для друзей: ссылка на релизы, про SmartScreen, без почты', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
    expect(readme).toContain('Выполнить в любом случае')
    expect(readme).toContain('SOJuse/qclod/releases')
    expect(readme).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
  })
  test('чек-лист описывает вход через claude auth login', () => {
    const list = readFileSync(resolve(root, 'docs/superpowers/checklists/release-smoke.md'), 'utf8')
    expect(list).toContain('claude auth login')
    expect(list).not.toContain('Открыть терминал')
  })
})
