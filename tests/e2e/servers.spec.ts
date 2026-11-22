import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchQclod } from './helpers/launch'
import { shot } from './helpers/shot'

/**
 * The server screens of the window (stage 6 fix wave): there is no sshd in
 * e2e, so main is made to say what a server would — the server list, the
 * chat's tab on it, a folder listing — through its own channels. The local
 * shell stands in for ssh in the terminal (QCLOD_E2E_TERMINAL).
 */

const SERVER = {
  id: 'h1',
  label: 'Дом',
  target: 'me@home',
  auth: 'key',
  colour: 'green',
  recent: [],
  fromConfig: false,
  state: 'online',
  hasPassword: false
}
const KEY_PROBLEM =
  'Ключ сервера изменился. Если сервер переустанавливали — удалите старый ключ: ssh-keygen -R home, иначе не подключайтесь.'

/** main tells the window, as it would after a connect or a tab change. */
async function push(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [ch, p]) => BrowserWindow.getAllWindows()[0]!.webContents.send(ch as string, p), [channel, payload])
}

/** A sheet's opening eases in: the picture is taken once it stands still. */
async function settled(win: Page, selector: string): Promise<void> {
  await win
    .locator(selector)
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => undefined))
}

/** The first chat, said to run on the server; main's own tab stays local, so its terminal is the local shell. */
async function serverChat(app: ElectronApplication, win: Page, server: Record<string, unknown>): Promise<string> {
  const tabId = (await win.locator('[data-testid="chat-pane"]').first().getAttribute('data-tab'))!
  await push(app, 'servers:changed', [server])
  const tabs = await win.evaluate(() => window.qclod.listTabs())
  await push(
    app,
    'tabs:changed',
    tabs.map((t) => (t.id === tabId ? { ...t, server: { hostId: 'h1' } } : t))
  )
  await expect(win.locator('[data-testid="server-badge"]')).toBeVisible()
  return tabId
}

test('сменившийся ключ сервера — опасность в шапке, плашке и чек-листе', async () => {
  const { app, win } = await launchQclod()
  try {
    await serverChat(app, win, { ...SERVER, state: 'hostKeyChanged', problem: KEY_PROBLEM })
    const link = win.locator('[data-testid="server-link"]')
    await expect(link).toHaveText('ключ сервера изменился')
    await expect(link).toHaveAttribute('data-danger', 'true')
    await expect(win.locator('[data-testid="server-key-changed"]')).toContainText(KEY_PROBLEM)
    await link.click()
    const problem = win.locator('[data-testid="servers-sheet"] [data-testid="server-problem"]')
    await expect(problem).toHaveAttribute('role', 'alert')
    await settled(win, '[data-testid="servers-sheet"]')
    await shot(win, 'servers-key-changed')
    // Esc closes the sheet and does not reach the agent.
    await win.keyboard.press('Escape')
    await expect(win.locator('[data-testid="servers-sheet"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('выбор папки на сервере: фокус в поле пути, Enter не уходит агенту', async () => {
  const { app, win } = await launchQclod()
  try {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('servers:listDir')
      ipcMain.handle('servers:listDir', (_e, _hostId: string, path: string) => ({
        path: path === '~' ? '~' : path,
        entries: [
          { name: 'projects', kind: 'dir', size: 0, mtime: 0 },
          { name: 'site', kind: 'dir', size: 0, mtime: 0 },
          { name: 'shared', kind: 'link', size: 0, mtime: 0 },
          { name: 'notes.md', kind: 'file', size: 1, mtime: 0 }
        ],
        truncated: false
      }))
    })
    await push(app, 'servers:changed', [SERVER])
    const input = win.locator('[data-testid="composer-input"]')
    await input.fill('не отправлять')
    await win.locator('[data-testid="new-chat-server"]').click()
    await win.locator('[data-testid="tab-new"]').click()
    await win.locator('[data-testid="server-row"]').first().click()
    const path = win.locator('[data-testid="remote-path"]')
    await expect(path).toBeFocused()
    await expect(win.locator('[data-testid="remote-dir"][data-kind="link"]')).toBeVisible()
    await settled(win, '[data-testid="servers-sheet"]')
    await shot(win, 'servers-folder-picker-focus')
    await win.keyboard.press('Enter')
    // The draft is still there: Enter went to the picker, not to the agent.
    await expect(input).toHaveValue('не отправлять')
    await expect(win.locator('[data-testid="ribbon"] [data-kind="user"]')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('терминал сервера: показ ставит фокус, «Скрыть» возвращает его в ввод', async () => {
  const { app, win } = await launchQclod({ env: { QCLOD_E2E_TERMINAL: '1' } })
  try {
    await serverChat(app, win, SERVER)
    await win.locator('[data-testid="open-terminal"]').click()
    const drawer = win.locator('[data-testid="terminal-drawer"]')
    await expect(drawer).toBeVisible()
    await expect(drawer.locator('.xterm-helper-textarea')).toBeFocused()
    await win.keyboard.type('echo qclod-terminal\r')
    await expect(drawer).toContainText('qclod-terminal', { timeout: 15000 })
    await shot(win, 'servers-terminal')
    await win.locator('[data-testid="terminal-hide"]').click()
    await expect(win.locator('[data-testid="composer-input"]')).toBeFocused()
  } finally {
    await app.close()
  }
})
