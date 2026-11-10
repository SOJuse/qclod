import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOTS = resolve(__dirname, '../.artifacts')

async function launch(
  agentPath: string,
  extraEnv: Record<string, string> = {}
): Promise<{ app: ElectronApplication; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'qclod-setup-'))
  // The agent path is a setting, so a profile that names a missing one is how
  // a machine without Claude Code looks.
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ agentPath }), 'utf8')
  // Windows keeps PATH as "Path"; a spec that replaces it must not leave both.
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !('PATH' in extraEnv && /^path$/i.test(key)))
  )
  const app = await electron.launch({
    args: ['.'],
    env: {
      ...base,
      QCLOD_USER_DATA: profile,
      QCLOD_FAKE_SDK_SCRIPT: JSON.stringify({ steps: [] }),
      ...extraEnv
    } as Record<string, string>
  })
  return { app, profile }
}

async function close(app: ElectronApplication, profile: string): Promise<void> {
  await app.close().catch(() => undefined)
  rmSync(profile, { recursive: true, force: true })
}

async function shot(win: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  await win.screenshot({ path: join(SHOTS, `setup-${name}.png`) })
}

/**
 * A machine without Claude Code: this one has it on PATH and in the usual
 * places, so the search is pointed at an empty folder instead.
 */
const cleanDirs: string[] = []
test.afterEach(() => {
  for (const dir of cleanDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cleanMachine(): { env: Record<string, string>; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-clean-'))
  cleanDirs.push(dir)
  const windows = process.env['SystemRoot'] ?? 'C:\\Windows'
  return {
    dir,
    env: { PATH: join(windows, 'System32'), LOCALAPPDATA: dir, APPDATA: dir, USERPROFILE: dir }
  }
}

const fakeInstall = (config: { methods: string[]; results: boolean[]; createAgentAt?: string }) => ({
  QCLOD_FAKE_INSTALL: JSON.stringify(config)
})
const fakeAuth = (config: { sequence: string[]; pollMs?: number; maxMs?: number }) => ({
  QCLOD_FAKE_AUTH: JSON.stringify(config)
})

test('без Claude Code встречает экран установки, а не пустое окно', async () => {
  const clean = cleanMachine()
  const { app, profile } = await launch('claude', { ...clean.env, ...fakeInstall({ methods: ['winget'], results: [] }) })
  try {
    const win = await app.firstWindow()
    const setup = win.locator('[data-testid="setup-screen"]')

    await expect(setup).toBeVisible({ timeout: 20000 })
    await expect(setup).toContainText('Подготовим Qclod к работе')
    await expect(win.locator('[data-testid="setup-step-agent"]')).toHaveAttribute('data-state', 'active')
    await expect(win.locator('[data-testid="setup-step-login"]')).toHaveAttribute('data-state', 'todo')
    await expect(win.locator('[data-testid="setup-install"]')).toBeVisible()
    // A future step shows no button.
    await expect(win.locator('[data-testid="setup-login"]')).toHaveCount(0)

    // Nothing to work in until it is there.
    await expect(win.locator('[data-testid="setup-done"]')).toBeDisabled()
    await expect(win.locator('[data-testid="composer-input"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('кнопка установки активна — ставить есть чем, и ничего больше не просят', async () => {
  const clean = cleanMachine()
  const { app, profile } = await launch('claude', { ...clean.env, ...fakeInstall({ methods: ['winget'], results: [] }) })
  try {
    const win = await app.firstWindow()
    const step = win.locator('[data-testid="setup-step-agent"]')

    await expect(step).toBeVisible({ timeout: 20000 })
    await expect(step).toContainText('Не установлен на этом компьютере.')
    await expect(win.locator('[data-testid="setup-install"]')).toBeEnabled()
    await shot(win, 'agent-missing')

    // winget ships with Windows, so no shopping list is shown.
    await expect(win.locator('[data-testid="setup-no-method"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="setup-agent-problem"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="setup-screen"]')).not.toContainText('Node.js')
  } finally {
    await close(app, profile)
  }
})

test('с установленным агентом экран установки не мешает', async () => {
  const { app, profile } = await launch('claude')
  try {
    const win = await app.firstWindow()

    await expect(win.locator('[data-testid="composer-input"]')).toBeVisible({ timeout: 20000 })
    await expect(win.locator('[data-testid="setup-screen"]')).toHaveCount(0)
  } finally {
    await close(app, profile)
  }
})

test('ставит, затем ведёт ко входу', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-agent-'))
  const agent = join(dir, 'claude.exe')
  const { app, profile } = await launch(agent, {
    ...fakeInstall({ methods: ['winget'], results: [true], createAgentAt: agent }),
    ...fakeAuth({ sequence: ['out', 'out', 'in'], pollMs: 100 })
  })
  try {
    const win = await app.firstWindow()
    const agentStep = win.locator('[data-testid="setup-step-agent"]')
    const loginStep = win.locator('[data-testid="setup-step-login"]')

    await win.locator('[data-testid="setup-install"]').click({ timeout: 20000 })
    await expect(win.locator('[data-testid="setup-log"]')).toContainText('фейковая установка: winget')
    await expect(agentStep).toHaveAttribute('data-state', 'done')
    await expect(agentStep).toContainText('Установлен')
    await expect(loginStep).toHaveAttribute('data-state', 'active')
    await expect(win.locator('[data-testid="setup-login-state"]')).toContainText('Нужно войти один раз.')
    // Found, though not logged in yet: nobody gets stuck behind a wrong check.
    await expect(win.locator('[data-testid="setup-done"]')).toBeEnabled()
    await shot(win, 'login-out')

    await win.locator('[data-testid="setup-login"]').click()
    const opens = await app.evaluate(
      () => (globalThis as { __qclodLoginOpens?: string[] }).__qclodLoginOpens?.length ?? 0
    )
    expect(opens).toBe(1)
    await expect(win.locator('[data-testid="setup-login-state"]')).toContainText('Жду входа')
    await shot(win, 'login-waiting')
    await expect(win.locator('[data-testid="setup-login-state"]')).toContainText('Вход выполнен.')
    await expect(loginStep).toHaveAttribute('data-state', 'done')
    await shot(win, 'all-done')

    await win.locator('[data-testid="setup-done"]').click()
    await expect(win.locator('[data-testid="composer-input"]')).toBeVisible()
  } finally {
    await close(app, profile)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('winget упал — поставил npm', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-agent-'))
  const agent = join(dir, 'claude.exe')
  const { app, profile } = await launch(agent, {
    ...fakeInstall({ methods: ['winget', 'npm'], results: [false, true], createAgentAt: agent }),
    ...fakeAuth({ sequence: ['out'] })
  })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="setup-install"]').click({ timeout: 20000 })
    await expect(win.locator('[data-testid="setup-log"]')).toContainText('пробую через npm')
    await expect(win.locator('[data-testid="setup-step-agent"]')).toHaveAttribute('data-state', 'done')
    // After success the log folds to its last line.
    await shot(win, 'installed-log')
  } finally {
    await close(app, profile)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('установка не вышла — можно ещё раз или в настройки', async () => {
  const clean = cleanMachine()
  const { app, profile } = await launch('claude', { ...clean.env, ...fakeInstall({ methods: ['winget'], results: [false] }) })
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="setup-install"]').click({ timeout: 20000 })
    const step = win.locator('[data-testid="setup-step-agent"]')
    await expect(step).toContainText('Установить не получилось.')
    await expect(step).toHaveAttribute('data-state', 'blocked')
    await expect(win.locator('[data-testid="setup-install"]')).toHaveText('Попробовать снова')
    await expect(win.locator('[data-testid="setup-open-settings"]')).toBeVisible()
    await shot(win, 'install-failed')
  } finally {
    await close(app, profile)
  }
})

test('нечем ставить — ведёт в настройки', async () => {
  const clean = cleanMachine()
  const { app, profile } = await launch('claude', { ...clean.env, ...fakeInstall({ methods: [], results: [] }) })
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="setup-no-method"]')).toBeVisible({ timeout: 20000 })
    await expect(win.locator('[data-testid="setup-step-agent"]')).toHaveAttribute('data-state', 'blocked')
    await expect(win.locator('[data-testid="setup-install"]')).toHaveCount(0)
    await shot(win, 'no-method')

    await win.locator('[data-testid="setup-open-settings"]').click()
    const field = win.locator('[data-testid="setting-agentPath"]')
    await expect(field).toBeFocused()
    await field.fill(process.execPath)
    await win.locator('[data-testid="close-settings"]').click()

    await expect(win.locator('[data-testid="settings"]')).toHaveCount(0)
    await expect(win.locator('[data-testid="setup-step-agent"]')).toHaveAttribute('data-state', 'done')
  } finally {
    await close(app, profile)
  }
})

test('обёртка .cmd названа', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qclod-agent-'))
  const shim = join(dir, 'claude.cmd')
  writeFileSync(shim, '@echo off\r\n', 'utf8')
  const { app, profile } = await launch(shim, fakeInstall({ methods: ['winget'], results: [] }))
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="setup-agent-problem"]')).toContainText('.cmd-обёртка', {
      timeout: 20000
    })
    await expect(win.locator('[data-testid="setup-open-settings"]')).toBeVisible()
    await shot(win, 'agent-problem')
  } finally {
    await close(app, profile)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('не дождался входа', async () => {
  const { app, profile } = await launch(process.execPath, fakeAuth({ sequence: ['out'], pollMs: 50, maxMs: 300 }))
  try {
    const win = await app.firstWindow()
    await win.locator('[data-testid="setup-login"]').click({ timeout: 20000 })
    await expect(win.locator('[data-testid="setup-login-state"]')).toContainText('Не дождался входа')
    await expect(win.locator('[data-testid="setup-login"]')).toHaveText('Войти')
    await shot(win, 'login-timeout')
  } finally {
    await close(app, profile)
  }
})

test('агент есть, вход не выполнен — сразу шаг 2', async () => {
  const { app, profile } = await launch(process.execPath, fakeAuth({ sequence: ['out', 'unknown'] }))
  try {
    const win = await app.firstWindow()
    await expect(win.locator('[data-testid="setup-screen"]')).toBeVisible({ timeout: 20000 })
    await expect(win.locator('[data-testid="setup-step-agent"]')).toHaveAttribute('data-state', 'done')
    await expect(win.locator('[data-testid="setup-step-login"]')).toHaveAttribute('data-state', 'active')
    await expect(win.locator('[data-testid="setup-done"]')).toBeEnabled()

    // A check that could not tell asks for nothing more.
    await win.locator('[data-testid="setup-recheck"]').click()
    await expect(win.locator('[data-testid="setup-login-state"]')).toContainText('Не удалось проверить вход.')
    await expect(win.locator('[data-testid="setup-login"]')).toHaveCount(0)
    await shot(win, 'login-unknown')
  } finally {
    await close(app, profile)
  }
})
