import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TabController } from '@main/tabs/TabController'
import { SessionManager } from '@main/sessions/SessionManager'
import { DEFAULT_SETTINGS } from '@main/store/settingsStore'
import { loadTabs } from '@main/store/tabsStore'
import type { TabState } from '@shared/types'
import { FAKE_AGENT } from './helpers/pty'

const NODE = process.execPath

let storeDir: string
let projectA: string
let projectB: string
let manager: SessionManager
const managers: SessionManager[] = []
let changes: TabState[][]

function makeController(defaultCwd = projectA): TabController {
  manager = new SessionManager({
    getSettings: () => ({ ...DEFAULT_SETTINGS, agentPath: NODE }),
    getUserHooks: () => undefined,
    pipePath: '\\\\.\\pipe\\qclod-test',
    prefixArgs: [FAKE_AGENT]
  })
  changes = []
  managers.push(manager)
  return new TabController({
    manager,
    storeDir,
    defaultCwd,
    onData: () => undefined,
    onExit: () => undefined,
    onChanged: (tabs) => changes.push(tabs)
  })
}

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'qclod-tabctl-'))
  projectA = mkdtempSync(join(tmpdir(), 'qclod-proj-a-'))
  projectB = mkdtempSync(join(tmpdir(), 'qclod-proj-b-'))
})

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.disposeAll()))
  for (const dir of [storeDir, projectA, projectB]) rmSync(dir, { recursive: true, force: true })
})

describe('TabController', () => {
  test('на чистой установке открывается одна вкладка с папкой по умолчанию', () => {
    const c = makeController()
    const tabs = c.restore()
    expect(tabs).toHaveLength(1)
    expect(tabs[0].cwd).toBe(projectA)
    expect(c.activeTabId).toBe(tabs[0].id)
  })

  test('заголовок вкладки — имя папки', () => {
    const c = makeController()
    const tab = c.create(projectB)
    expect(tab.title).toBe(join(projectB).split(/[\\/]/).pop())
  })

  test('созданная вкладка становится активной', () => {
    const c = makeController()
    c.restore()
    const second = c.create(projectB)
    expect(c.activeTabId).toBe(second.id)
  })

  test('вкладки сохраняются на диск при каждом изменении', () => {
    const c = makeController()
    c.restore()
    c.create(projectB, { model: 'haiku' })
    const stored = loadTabs(storeDir)
    expect(stored).toHaveLength(2)
    expect(stored[1].cwd).toBe(projectB)
    expect(stored[1].overrides).toEqual({ model: 'haiku' })
  })

  test('закрытие вкладки убирает её и гасит сессию', async () => {
    const c = makeController()
    c.restore()
    const second = c.create(projectB)
    await c.close(second.id)
    expect(c.list().map((t) => t.id)).not.toContain(second.id)
    expect(manager.get(second.id)).toBeUndefined()
  })

  test('закрытие последней вкладки открывает новую, а не оставляет пустоту', async () => {
    const c = makeController()
    const [only] = c.restore()
    await c.close(only.id)
    expect(c.list()).toHaveLength(1)
    expect(c.list()[0].id).not.toBe(only.id)
  })

  test('вкладка с исчезнувшей папкой не запускает агента и объясняет причину', () => {
    const c = makeController()
    const missing = join(tmpdir(), 'qclod-definitely-missing-xyz')
    const tab = c.create(missing)
    expect(tab.status).toBe('error')
    expect(tab.error).toContain(missing)
    expect(manager.get(tab.id)).toBeUndefined()
  })

  test('бейдж загорается, когда закончила неактивная вкладка', () => {
    const c = makeController()
    const [first] = c.restore()
    const second = c.create(projectB)
    c.setStatus(first.id, 'idle')
    expect(c.list().find((t) => t.id === first.id)?.badge).toBe(true)
    expect(c.list().find((t) => t.id === second.id)?.badge).toBe(false)
  })

  test('бейдж не загорается на активной вкладке', () => {
    const c = makeController()
    const [first] = c.restore()
    c.setStatus(first.id, 'waiting')
    expect(c.list()[0].badge).toBe(false)
  })

  test('переход на вкладку гасит её бейдж', () => {
    const c = makeController()
    const [first] = c.restore()
    c.create(projectB)
    c.setStatus(first.id, 'idle')
    c.activate(first.id)
    expect(c.list().find((t) => t.id === first.id)?.badge).toBe(false)
    expect(c.activeTabId).toBe(first.id)
  })

  test('восстановление поднимает вкладки с теми же папками', () => {
    const first = makeController()
    first.restore()
    first.create(projectB, { permissionMode: 'plan' })

    const second = makeController()
    const restored = second.restore()
    expect(restored.map((t) => t.cwd)).toEqual([projectA, projectB])
    expect(restored[1].overrides).toEqual({ permissionMode: 'plan' })
  })

  test('восстановление помечает вкладку, чьей папки больше нет', () => {
    const vanished = mkdtempSync(join(tmpdir(), 'qclod-vanish-'))
    mkdirSync(vanished, { recursive: true })
    const first = makeController()
    first.restore()
    first.create(vanished)
    rmSync(vanished, { recursive: true, force: true })

    const second = makeController()
    const restored = second.restore()
    expect(restored).toHaveLength(2)
    expect(restored[1].status).toBe('error')
    expect(restored[1].missingCwd).toBe(true)
  })

  test('каждое изменение рассылается подписчику', () => {
    const c = makeController()
    c.restore()
    const before = changes.length
    c.create(projectB)
    expect(changes.length).toBeGreaterThan(before)
  })
})
