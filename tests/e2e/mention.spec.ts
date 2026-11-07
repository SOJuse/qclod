import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let app: ElectronApplication
let win: Page
let profile: string
let project: string

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), 'qclod-prof-'))
  project = mkdtempSync(join(tmpdir(), 'qclod-mention-'))
  mkdirSync(join(project, 'src', 'app'), { recursive: true })
  writeFileSync(join(project, 'src', 'app', 'main.ts'), '', 'utf8')
  writeFileSync(join(project, 'README.md'), '', 'utf8')

  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_PICK_FOLDER: project
    } as Record<string, string>
  })
  win = await app.firstWindow()
  await expect(win.locator('[data-testid="tab-strip"]')).toBeVisible()
  // Open a tab rooted in the fixture project.
  await win.keyboard.press('Control+t')
  await expect(win.locator('[data-testid="tab"]')).toHaveCount(2)
  await win.locator('[data-testid="composer-input"]').click()
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  for (const dir of [profile, project]) rmSync(dir, { recursive: true, force: true })
})

test('@ открывает попап и выбор вставляет путь в поле', async () => {
  await win.keyboard.type('глянь @ma')
  await expect(win.locator('[data-testid="mention-popup"]')).toBeVisible()
  await expect(win.locator('[data-testid="mention-item"]').first()).toContainText('main.ts')

  await win.keyboard.press('Tab')
  await expect(win.locator('[data-testid="composer-input"]')).toHaveValue(
    'глянь @src/app/main.ts '
  )
  await expect(win.locator('[data-testid="mention-popup"]')).toBeHidden()
})

test('стрелки двигают выбор в попапе, Esc закрывает', async () => {
  await win.keyboard.type('@')
  await expect(win.locator('[data-testid="mention-popup"]')).toBeVisible()

  await win.keyboard.press('ArrowDown')
  await expect(win.locator('[data-testid="mention-item"]').nth(1)).toHaveClass(/is-selected/)

  await win.keyboard.press('Escape')
  await expect(win.locator('[data-testid="mention-popup"]')).toBeHidden()
})
