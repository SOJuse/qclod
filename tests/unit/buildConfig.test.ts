import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { APP_ID } from '../../src/shared/appId'
import { TRAY_GLYPH } from '../../src/main/brand/trayGlyph'

const root = resolve(__dirname, '../..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const yml = readFileSync(resolve(root, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n')

const read = (p: string): string => readFileSync(resolve(root, p), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('.github/workflows/release.yml')

/** The lines of a top-level YAML section: from `name:` to the next unindented key. */
function section(text: string, name: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === `${name}:`)
  expect(start, `секция ${name}`).toBeGreaterThanOrEqual(0)
  const body: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (l !== '' && !l.startsWith(' ') && !l.startsWith('#')) break
    body.push(l)
  }
  return body.join('\n')
}

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

describe('голос', () => {
  test('нативный голосовой движок распакован из asar', () => {
    const unpack = yml.split(/^asarUnpack:\n/m)[1]?.split(/^\S/m)[0] ?? ''
    for (const glob of [
      'node_modules/sherpa-onnx-node/**/*',
      'node_modules/sherpa-onnx-win-x64/**/*',
      'node_modules/sherpa-onnx-darwin-arm64/**/*'
    ]) {
      expect(unpack).toContain(`  - ${glob}\n`)
    }
  })
  test('sherpa-onnx-node закреплён точно на 2.0.2', () => {
    expect(pkg.dependencies['sherpa-onnx-node']).toBe('2.0.2')
  })
})

describe('иконка', () => {
  test('electron-builder берёт ICO для Windows и ICNS для macOS', () => {
    const win = yml.split(/^win:\n/m)[1]?.split(/^\S/m)[0] ?? ''
    expect(win).toContain('  icon: build/icon.ico\n')
    expect(section(yml, 'mac')).toMatch(/^ {2}icon: build\/icon\.icns$/m)
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

describe('electron-builder.yml: Mac', () => {
  const mac = section(yml, 'mac')

  test('только DMG для arm64', () => {
    expect(mac).toMatch(/target:\n\s+- target: dmg\n\s+arch:\n\s+- arm64\n/)
    expect(mac).not.toMatch(/x64|universal|zip/)
  })

  test('без подписи electron-builder: подписывает afterPack', () => {
    expect(mac).toMatch(/^ {2}identity: null$/m)
    expect(mac).toMatch(/^ {2}hardenedRuntime: false$/m)
    expect(mac).toMatch(/^ {2}notarize: false$/m)
    expect(mac).toMatch(/^ {2}minimumSystemVersion: '11\.0'$/m)
  })

  test('afterPack указывает на существующий файл, который подписывает ad-hoc', () => {
    expect(yml).toMatch(/^afterPack: build\/afterPack\.cjs$/m)
    expect(existsSync(resolve(root, 'build/afterPack.cjs'))).toBe(true)
    const script = read('build/afterPack.cjs')
    expect(script).toContain("'--force', '--deep', '-s', '-'")
    expect(script).toContain("'--verify', '--deep', '--strict'")
    expect(script).toContain("electronPlatformName !== 'darwin'")
  })

  test('платформенные бинарники SDK в сборку не попадают', () => {
    expect(yml).toContain("- '!node_modules/@anthropic-ai/claude-agent-sdk-*/**'")
  })

  test('DMG: имя, фон и окно 540x380', () => {
    const dmg = section(yml, 'dmg')
    expect(dmg).toContain('artifactName: Qclod-${version}-arm64.${ext}')
    expect(dmg).toMatch(/background: build\/dmgBackground\.png/)
    expect(dmg).toMatch(/width: 540\n\s+height: 380/)
    expect(existsSync(resolve(root, 'build/dmgBackground.png'))).toBe(true)
  })

  test('значок строки меню едет в ресурсы', () => {
    expect(section(yml, 'extraResources')).toMatch(/from: build\/tray\n\s+to: tray/)
  })
})

describe('release.yml', () => {
  test('триггеры: теги v*.*.* и ветки release/**, ci/**; ни workflow_dispatch, ни dry_run', () => {
    expect(workflow).toMatch(/tags: \['v\*\.\*\.\*'\]/)
    expect(workflow).toMatch(/branches: \['release\/\*\*', 'ci\/\*\*'\]/)
    expect(workflow).not.toMatch(/workflow_dispatch|dry_run/)
  })

  test('jobs: win (не release) и mac после win на macos-latest', () => {
    expect(workflow).toMatch(/^ {2}win:\n {4}runs-on: windows-latest$/m)
    expect(workflow).not.toMatch(/^ {2}release:/m)
    expect(workflow).toMatch(/^ {2}mac:\n {4}needs: win\n {4}runs-on: macos-latest$/m)
  })

  test('публикация (check-release-tag, npm run release, gh release upload) — только под тегом', () => {
    const steps = workflow.split(/\n(?= {6}- )/)
    const publishing = steps.filter((s) =>
      /node scripts\/check-release-tag\.mjs|npm run release\b|gh release upload/.test(s)
    )
    expect(publishing.length).toBe(4)
    for (const step of publishing) expect(step).toContain("if: startsWith(github.ref, 'refs/tags/v')")
  })

  test('без тега: сборка без публикации и артефакты', () => {
    expect(workflow).toContain('run: npm run dist\n')
    expect(workflow).toContain('npm run dist:mac')
    expect(workflow.match(/upload-artifact@v4/g)).toHaveLength(2)
    expect(workflow).toContain('retention-days: 7')
  })

  test('mac: e2e на собранном .app, ad-hoc подпись проверяется, ключ подписи не ищется', () => {
    expect(workflow).toContain("CSC_IDENTITY_AUTO_DISCOVERY: 'false'")
    expect(workflow).toContain('QCLOD_PACKAGED_EXE: dist-e2e/mac-arm64/Qclod.app/Contents/MacOS/Qclod')
    expect(workflow).toContain('npx playwright test packaged mac')
    expect(workflow).toContain("codesign -dv dist/mac-arm64/Qclod.app 2>&1 | grep 'Signature=adhoc'")
    expect(workflow).toContain('codesign --verify --deep --strict')
  })
})

describe('package.json: сценарии Mac', () => {
  test('dist:mac собирает DMG arm64 без публикации, dist:e2e:mac: .app с тестовыми лазейками', () => {
    const scripts = pkg.scripts as Record<string, string>
    expect(scripts['dist:mac']).toContain('electron-builder --mac --arm64 --publish never')
    expect(scripts['dist:mac']).toContain('check:seams')
    expect(scripts['dist:e2e:mac']).toContain('build:e2e')
    expect(scripts['dist:e2e:mac']).toContain('--mac dir --arm64')
    expect(scripts['dist:e2e:mac']).toContain('dist-e2e')
  })
})

describe('README: Qclod на Mac', () => {
  test('шаги установки, в том числе «Открыть всё равно» и xattr', () => {
    const readme = read('README.md')
    expect(readme).toContain('## Qclod на Mac')
    expect(readme).toContain('«Открыть всё равно»')
    expect(readme).toContain('xattr -dr com.apple.quarantine /Applications/Qclod.app')
    expect(readme).toContain('Qclod-<версия>-arm64.dmg')
  })
})
