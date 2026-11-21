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

/** One job of release.yml: its lines, up to the next job at the same depth. */
function job(workflow: string, name: string): string {
  const jobs = workflow.split(/^jobs:\n/m)[1] ?? ''
  const parts = jobs.split(/^(?= {2}[a-z][\w-]*:\n)/m)
  return parts.find((p) => p.startsWith(`  ${name}:\n`)) ?? ''
}

/** The steps of a job, one string each. */
function steps(jobText: string): string[] {
  return jobText.split(/\n(?= {6}- )/)
}

describe('CI посредника (этап 6)', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n')
  const relay = job(workflow, 'relay')
  const win = job(workflow, 'win')
  const TAG_ONLY = "if: startsWith(github.ref, 'refs/tags/v')"

  test('один workflow: тег публикует, release/** и ci/** — без публикации', () => {
    expect(workflow).toContain("tags: ['v*.*.*']")
    expect(workflow).toContain("branches: ['release/**', 'ci/**']")
    expect(workflow).not.toContain('workflow_dispatch')
    expect(workflow).not.toContain('dry_run')
    expect(job(workflow, 'release')).toBe('')
  })

  test('job relay: два родных раннера, Node 22, сборка, смоук версии, артефакты', () => {
    expect(relay).toContain('runner: ubuntu-latest')
    expect(relay).toContain('arch: x64')
    expect(relay).toContain('runner: ubuntu-24.04-arm')
    expect(relay).toContain('arch: arm64')
    expect(relay).toContain('node-version: 22')
    expect(relay).toContain('npm run build:relay && npm run relay:sea')
    expect(relay).toContain('./dist-relay/qclod-relay-linux-${{ matrix.arch }} version')
    expect(relay).toContain('actions/upload-artifact')
    expect(relay).toContain('dist-relay/*.gz')
  })

  test('ssh-петля на x64: sshd, tmux, ключ, тестовая сборка, интеграционные тесты', () => {
    expect(relay).toContain('sudo apt-get install -y openssh-server tmux')
    expect(relay).toContain("ssh-keygen -t ed25519 -N ''")
    expect(relay).toContain('authorized_keys')
    expect(relay).toContain('sudo systemctl start ssh')
    expect(relay).toContain('npm run build:relay:e2e')
    expect(relay).toContain('npm run test:integration')
    expect(relay).toContain('QCLOD_SSH_LOOP_HOST: localhost')
    expect(relay).toContain('QCLOD_RELAY_BINARY_DIR: dist-relay-e2e')
    const loop = steps(relay).find((s) => s.includes('npm run test:integration'))!
    expect(loop).toContain("if: matrix.arch == 'x64'")
  })

  test('job win: needs relay; .gz в релиз раньше npm run release; черновик и публикация — только по тегу', () => {
    expect(win).toMatch(/needs: (relay|\[[^\]]*\brelay\b[^\]]*\])/)
    expect(win).toContain('actions/download-artifact')
    expect(win).toContain('node scripts/relay-manifest.mjs')
    const draft = win.indexOf('gh release create "$GITHUB_REF_NAME" --draft --verify-tag')
    const upload = win.indexOf('gh release upload "$GITHUB_REF_NAME" dist-relay/*.gz --clobber')
    const release = win.indexOf('run: npm run release')
    const visible = win.indexOf('gh release edit "$GITHUB_REF_NAME" --draft=false')
    expect(draft).toBeGreaterThan(0)
    expect(upload).toBeGreaterThan(draft)
    expect(release).toBeGreaterThan(upload)
    expect(visible).toBeGreaterThan(release)
    for (const marker of ['--draft --verify-tag', 'dist-relay/*.gz --clobber', 'run: npm run release', '--draft=false']) {
      const step = steps(win).find((s) => s.includes(marker))!
      expect(step, marker).toContain(TAG_ONLY)
    }
  })

  test('без тега .gz уходят в upload-artifact вместе с exe', () => {
    const artifact = steps(win).find((s) => s.includes('actions/upload-artifact'))!
    expect(artifact).toContain("!startsWith(github.ref, 'refs/tags/v')")
    expect(artifact).toContain('dist/*.exe')
    expect(artifact).toContain('dist-relay/*.gz')
  })

  test('манифест посредника — в ресурсах установщика; сборка посредника в package.json', () => {
    expect(yml).toMatch(/^extraResources:\n {2}- from: build\/relay-manifest\.json\n {4}to: relay-manifest\.json$/m)
    expect(pkg.scripts['build:relay']).toBe('node scripts/build-relay.mjs')
    expect(pkg.scripts['build:relay:e2e']).toBe('node scripts/build-relay.mjs --e2e')
    expect(pkg.scripts['relay:sea']).toBe('node scripts/make-relay-sea.mjs')
    expect(pkg.scripts['test:integration']).toBe('vitest run -c vitest.integration.config.ts')
    // esbuild pinned to vite's own, postject for the SEA
    expect(pkg.devDependencies['esbuild']).toBe('0.21.5')
    expect(pkg.devDependencies['postject']).toBe('1.0.0-alpha.6')
    for (const script of ['dist', 'release']) {
      const line = pkg.scripts[script] as string
      expect(line.indexOf('npm run build:relay')).toBeGreaterThan(-1)
      expect(line.indexOf('npm run build:relay')).toBeLessThan(line.indexOf('npm run check:seams'))
    }
  })
})
