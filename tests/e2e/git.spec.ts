import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const AUTHOR = {
  GIT_AUTHOR_NAME: 'Тест',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'Тест',
  GIT_COMMITTER_EMAIL: 't@example.com'
}

let project: string
let profile: string
let app: ElectronApplication | null = null

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: project, env: { ...process.env, ...AUTHOR }, encoding: 'utf8' })

function writeTab(): void {
  profile = mkdtempSync(join(tmpdir(), 'qclod-git-profile-'))
  writeFileSync(
    join(profile, 'tabs.json'),
    JSON.stringify([{ id: 'a', cwd: project, title: 'Гит', overrides: {} }]),
    'utf8'
  )
}

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(profile, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

async function launch(): Promise<Page> {
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      ...AUTHOR,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SHELL: '1',
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [{ kind: 'text', text: 'Готово' }] })
    } as Record<string, string>
  })
  return app.firstWindow()
}

test('Git-слой: бейдж, diff, коммит отмеченных', async () => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-git-e2e-')))
  git('init', '-q', '-b', 'main')
  writeFileSync(join(project, 'one.ts'), 'const one = 1\n')
  writeFileSync(join(project, 'two.ts'), 'const two = 2\n')
  git('add', '-A')
  git('commit', '-qm', 'first')
  writeFileSync(join(project, 'one.ts'), 'const one = 11\n')
  writeFileSync(join(project, 'two.ts'), 'const two = 22\n')
  writeFileSync(join(project, 'new.ts'), 'const added = true\n')
  writeTab()

  const win = await launch()
  const open = win.locator('[data-testid="git-open"]')
  await expect(win.locator('[data-testid="git-badge"]')).toHaveText('3', { timeout: 15000 })
  await expect(open).toBeEnabled()

  await open.click()
  const layer = win.locator('[data-testid="git-layer"]')
  await expect(layer).toBeVisible()
  await expect(win.locator('[data-testid="pane-layer"]')).toHaveAttribute('aria-label', 'Изменения · main')
  await expect(win.locator('[data-testid="git-file"]')).toHaveCount(3)

  await win.locator('[data-testid="git-file"][data-path="one.ts"] .git-file-open').click()
  await expect(win.locator('[data-testid="diff-viewer"] .diff-line.is-add')).toContainText('const one = 11')

  // «Весь файл» and back.
  await win.locator('[data-testid="git-full-file"]').click()
  await expect(win.locator('[data-testid="viewer-text"]')).toContainText('const one = 11')
  await win.locator('[data-testid="viewer-close"]', { hasText: 'Назад к изменениям' }).click()
  await expect(win.locator('[data-testid="diff-viewer"]')).toBeVisible()

  // Untick two.ts, commit the other two.
  await win.locator('[data-testid="git-file"][data-path="two.ts"] [data-testid="git-file-check"]').uncheck()
  await win.locator('[data-testid="git-message"]').fill('Правка')
  const commit = win.locator('[data-testid="git-commit"]')
  await expect(commit).toHaveText('Закоммитить 2 файла')
  await commit.click()
  await expect(win.locator('[data-testid="git-done"]')).toContainText('Закоммичено: ')

  expect(git('log', '-1', '--format=%s').trim()).toBe('Правка')
  expect(git('status', '--porcelain')).toContain('two.ts')
  expect(git('status', '--porcelain')).not.toContain('one.ts')
  await expect(win.locator('[data-testid="git-file"]')).toHaveCount(1)
  await expect(win.locator('[data-testid="git-badge"]')).toHaveText('1')
})

test('папка без .git: кнопка неактивна, подсказка «Папка не под Git»', async () => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-git-e2e-')))
  writeTab()
  // Keep an enclosing repository (a temp folder inside one) from making this a repo.
  const win = await launch()
  const open = win.locator('[data-testid="git-open"]')
  await expect(open).toBeDisabled({ timeout: 15000 })
  await expect(open).toHaveAttribute('title', 'Папка не под Git')
})
