import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { catchCopies, copiedText } from './helpers/clipboard'

type ShellEntry = { action: 'open' | 'reveal' | 'editor'; path: string; line?: number }

let project: string
let profile: string
let app: ElectronApplication | null = null

test.beforeEach(() => {
  // The tab's folder: src/a.ts and an (empty) setup.exe. The long name, as
  // main compares and records it.
  project = realpathSync.native(mkdtempSync(join(tmpdir(), 'qclod-paths-')))
  mkdirSync(join(project, 'src'))
  writeFileSync(join(project, 'src', 'a.ts'), 'export const a = 1\n// two\n// three\n', 'utf8')
  writeFileSync(join(project, 'setup.exe'), '')
  profile = mkdtempSync(join(tmpdir(), 'qclod-paths-profile-'))
  writeFileSync(
    join(profile, 'tabs.json'),
    JSON.stringify([{ id: 'a', cwd: project, title: 'Пути', overrides: {} }]),
    'utf8'
  )
})

test.afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = null
  rmSync(profile, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

async function launch(steps: unknown[], settings?: Record<string, unknown>, nextTurn?: unknown[]): Promise<Page> {
  if (settings) writeFileSync(join(profile, 'settings.json'), JSON.stringify(settings), 'utf8')
  app = await electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SHELL: '1',
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify(nextTurn ? { steps, nextTurn } : { steps })
    } as Record<string, string>
  })
  return app.firstWindow()
}

async function shellLog(): Promise<ShellEntry[]> {
  return app!.evaluate(() => (globalThis as { __qclodShellLog?: ShellEntry[] }).__qclodShellLog ?? [])
}

const SAY = (text: string): unknown[] => [{ kind: 'text', text }]
const aTs = (): string => join(project, 'src', 'a.ts')

test('путь в ответе агента кликабелен и открывается', async () => {
  const win = await launch(SAY('Посмотрите src/a.ts:3 и src/нет.ts\n\n```\nsrc/a.ts\n```'))
  const answer = win.locator('[data-testid="ribbon-agentText"]').first()
  const link = answer.locator('[data-testid="path-link"]')
  await expect(link).toHaveCount(1, { timeout: 15000 })
  await expect(link).toHaveText('src/a.ts:3')
  // A code block is code, not a mention.
  await expect(answer.locator('[data-testid="md-code"] [data-testid="path-link"]')).toHaveCount(0)
  // Looks like the text around it until pointed at.
  expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe('none')

  await link.click()
  await expect.poll(shellLog).toContainEqual({ action: 'open', path: aTs() })
})

test('правый клик — меню; «Скопировать относительный путь» кладёт src\\a.ts в буфер', async () => {
  const win = await launch(SAY('Правил src/a.ts:3'))
  const link = win.locator('[data-testid="path-link"]').first()
  await expect(link).toBeVisible({ timeout: 15000 })

  await catchCopies(win)
  await link.click({ button: 'right' })
  const menu = win.locator('[data-testid="path-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu).toHaveAttribute('role', 'menu')
  const items = menu.locator('[data-testid="path-menu-item"]')
  await expect(items).toHaveText([
    'Открыть',
    'Показать в проводнике',
    'Скопировать путь',
    'Скопировать относительный путь',
    'Посмотреть'
  ])

  await items.filter({ hasText: 'Скопировать относительный путь' }).click()
  await expect(menu).toBeHidden()
  await expect.poll(() => copiedText(win)).toBe('src\\a.ts')
  // Copying does not open anything.
  expect(await shellLog()).toEqual([])
})

test('меню с клавиатуры: Shift+F10, стрелки, Enter; Esc закрывает', async () => {
  const win = await launch(SAY('Правил src/a.ts:3'))
  const link = win.locator('[data-testid="path-link"]').first()
  await expect(link).toBeVisible({ timeout: 15000 })

  await catchCopies(win)
  await link.focus()
  await win.keyboard.press('Shift+F10')
  const menu = win.locator('[data-testid="path-menu"]')
  await expect(menu).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(link).toBeFocused()

  await win.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  // Открыть → Показать → Скопировать путь.
  await win.keyboard.press('ArrowDown')
  await win.keyboard.press('ArrowDown')
  await win.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect.poll(() => copiedText(win)).toBe(aTs())
})

test('«Показать в проводнике»', async () => {
  const win = await launch(SAY('Правил src/a.ts:3'))
  const link = win.locator('[data-testid="path-link"]').first()
  await expect(link).toBeVisible({ timeout: 15000 })
  await link.click({ button: 'right' })
  await win.locator('[data-testid="path-menu-item"]', { hasText: 'Показать в проводнике' }).click()
  await expect.poll(shellLog).toEqual([{ action: 'reveal', path: aTs() }])
})

test('«Открыть в редакторе» есть только с заданной командой и передаёт строку', async () => {
  const win = await launch(SAY('Правил src/a.ts:3'))
  const link = win.locator('[data-testid="path-link"]').first()
  await expect(link).toBeVisible({ timeout: 15000 })
  await link.click({ button: 'right' })
  const items = win.locator('[data-testid="path-menu-item"]')
  await expect(items).toHaveCount(5)
  await expect(items.filter({ hasText: 'Открыть в редакторе' })).toHaveCount(0)
  await win.keyboard.press('Escape')

  // The setting, typed on the settings screen.
  await win.locator('[data-testid="open-settings"]').click()
  await win.locator('[data-testid="settings-nav-agent"]').click()
  const field = win.locator('[data-testid="setting-editorCommand"]')
  await expect(field).toHaveAttribute('placeholder', 'code -g {path}:{line}')
  await field.fill('code -g {path}:{line}')
  await field.blur()
  await expect(win.locator('[data-testid="settings-saved"]')).toBeVisible()
  await win.locator('[data-testid="close-settings"]').click()

  await link.click({ button: 'right' })
  await expect(items).toHaveCount(5)
  await items.filter({ hasText: 'Открыть в редакторе' }).click()
  await expect.poll(shellLog).toEqual([{ action: 'editor', path: aTs(), line: 3 }])
})

test('команда редактора, которую нельзя выполнить безопасно, объясняет почему', async () => {
  const win = await launch(SAY('Правил src/a.ts:3'), { editorCommand: 'ed "{path}' })
  const link = win.locator('[data-testid="path-link"]').first()
  await expect(link).toBeVisible({ timeout: 15000 })
  await link.click({ button: 'right' })
  await win.locator('[data-testid="path-menu-item"]', { hasText: 'Открыть в редакторе' }).click()
  const error = win.locator('[data-testid="path-menu-error"]')
  await expect(error).toHaveText(/кавыч/i)
  // The status colour is on the icon; the words stay text-coloured.
  await expect(error.locator('svg.lucide-circle-alert')).toHaveCount(1)
  await expect(error).toHaveCSS('color', await win.evaluate(() => getComputedStyle(document.body).color))
  expect(await shellLog()).toEqual([])
})

test('путь к .exe не запускается, а показывается в проводнике', async () => {
  const win = await launch(SAY('Скачан setup.exe'))
  const link = win.locator('[data-testid="path-link"]').first()
  await expect(link).toHaveText('setup.exe', { timeout: 15000 })
  await link.click()
  await expect.poll(shellLog).toEqual([{ action: 'reveal', path: join(project, 'setup.exe') }])
})

test('путь в карточке Read кликабелен', async () => {
  const win = await launch([
    { kind: 'tool', name: 'Read', input: { file_path: aTs() }, result: 'export const a = 1' }
  ])
  const card = win.locator('.tool-card[data-category="read"]').first()
  const link = card.locator('[data-testid="tool-head"] [data-testid="path-link"]')
  await expect(link).toHaveText('a.ts', { timeout: 15000 })
  await link.click()
  await expect.poll(shellLog).toEqual([{ action: 'open', path: aTs() }])
  // Opening the file does not unfold the card.
  await expect(card.locator('[data-testid="tool-detail"]')).toHaveCount(0)
})

test('пути в выводе команды и в списке найденного кликабельны', async () => {
  const win = await launch([
    {
      kind: 'tool',
      name: 'Bash',
      input: { command: 'git status' },
      result: 'modified: src/a.ts',
      output: { stdout: 'modified:   src/a.ts\n', stderr: 'warning: setup.exe', interrupted: false }
    },
    {
      kind: 'tool',
      name: 'Glob',
      input: { pattern: '**/*.ts' },
      result: aTs(),
      output: { filenames: [aTs()], numFiles: 1, durationMs: 1, truncated: false }
    }
  ])
  const command = win.locator('.tool-card[data-category="command"]').first()
  await expect(command).toBeVisible({ timeout: 15000 })
  await command.locator('[data-testid="tool-head"]').click()
  await expect(command.locator('[data-testid="tool-stdout"] [data-testid="path-link"]')).toHaveText('src/a.ts')
  await expect(command.locator('[data-testid="tool-stderr"] [data-testid="path-link"]')).toHaveText('setup.exe')
  await command.locator('[data-testid="tool-stdout"] [data-testid="path-link"]').click()
  await expect.poll(shellLog).toEqual([{ action: 'open', path: aTs() }])

  const search = win.locator('.tool-card[data-category="read"]').first()
  await search.locator('[data-testid="tool-head"]').click()
  await expect(search.locator('[data-testid="tool-match"] [data-testid="path-link"]')).toHaveText(aTs())
})

test('путь, названный до создания файла, становится ссылкой после Write', async () => {
  const later = join(project, 'src', 'b.ts')
  const win = await launch([
    { kind: 'text', text: 'Создам src/b.ts рядом с src/a.ts' },
    {
      kind: 'tool',
      name: 'Write',
      input: { file_path: later, content: 'export {}' },
      result: 'ok',
      pauseMs: 3000
    },
    { kind: 'text', text: 'Готово: src/b.ts' }
  ])
  const first = win.locator('[data-testid="ribbon-agentText"]').first()
  // Both texts go to main in one call: once src/a.ts is a link, main has
  // also said "no such file" about src/b.ts.
  await expect(first.locator('[data-testid="path-link"]')).toHaveText(['src/a.ts'], { timeout: 15000 })
  writeFileSync(later, 'export {}\n', 'utf8')

  const second = win.locator('[data-testid="ribbon-agentText"]').nth(1)
  await expect(second.locator('[data-testid="path-link"]')).toHaveText('src/b.ts', { timeout: 15000 })
  // The earlier mention is asked again too.
  await expect(first.locator('[data-testid="path-link"]')).toHaveText(['src/b.ts', 'src/a.ts'])
})

test('путь в подписи ссылки остаётся частью ссылки на адрес', async () => {
  const win = await launch(SAY('Правил src/a.ts:3, см. [src/a.ts:3](https://example.com/x)'))
  await app!.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = async (url: string) => {
      g.__opened!.push(url)
    }
  })
  const answer = win.locator('[data-testid="ribbon-agentText"]').first()
  await expect(answer.locator('[data-testid="path-link"]')).toHaveCount(1, { timeout: 15000 })
  const url = answer.locator('a.md-link')
  // One <a>: no file link nested inside the address link.
  await expect(url.locator('a')).toHaveCount(0)
  await url.click()
  await expect
    .poll(() => app!.evaluate(() => (globalThis as { __opened?: string[] }).__opened))
    .toEqual(['https://example.com/x'])
  expect(await shellLog()).toEqual([])
})

test('меню не закрывает прокрутка, которую делает сама лента, а колесо — закрывает', async () => {
  const win = await launch(SAY('Правил src/a.ts:3'))
  const link = win.locator('[data-testid="path-link"]').first()
  await expect(link).toBeVisible({ timeout: 15000 })
  await link.click({ button: 'right' })
  const menu = win.locator('[data-testid="path-menu"]')
  await expect(menu).toBeVisible()
  // The ribbon following a streaming answer scrolls by itself.
  await link.evaluate((el) => {
    for (let node = el.parentElement; node; node = node.parentElement) node.dispatchEvent(new Event('scroll'))
    document.dispatchEvent(new Event('scroll'))
  })
  await expect(menu).toBeVisible()
  await win.mouse.move(40, 400)
  await win.mouse.wheel(0, 120)
  await expect(menu).toBeHidden()
})

test('файл в строке «сейчас» — ссылка, которая открывает его', async () => {
  const win = await launch(SAY('слушаю'), undefined, [
    { kind: 'tool', name: 'Read', input: { file_path: aTs() }, result: 'export const a = 1', pauseMs: 4000 }
  ])
  const input = win.locator('[data-testid="composer-input"]')
  await expect(win.locator('[data-testid="ribbon"]')).toContainText('слушаю', { timeout: 15000 })
  await input.click()
  await input.fill('прочти')
  await input.press('Enter')

  const link = win.locator('[data-testid="now-line"] [data-testid="now-object"] [data-testid="path-link"]')
  await expect(link).toHaveText('a.ts', { timeout: 15000 })
  await link.click()
  await expect.poll(shellLog).toContainEqual({ action: 'open', path: aTs() })
})
