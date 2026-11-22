import { describe, expect, test, vi } from 'vitest'
import { chatsProvider } from '../../src/renderer/palette/chats'
import { projectsProvider } from '../../src/renderer/palette/projects'
import type { PaletteContext, PaletteRunner } from '../../src/renderer/palette/types'
import { buildSidebar } from '../../src/renderer/chat/sidebarModel'
import type { ServerView, TabState } from '../../src/shared/types'

const server: ServerView = { id: 'h1', label: 'Дом', target: 'me@home', auth: 'key', colour: 'blue', recent: [], fromConfig: false, state: 'online', hasPassword: false }
const tab = (id: string, cwd: string, title: string, hostId?: string): TabState =>
  ({ id, cwd, title, overrides: {}, status: 'idle', badge: false, ...(hostId ? { server: { hostId } } : {}) }) as TabState

function ctx(tabs: TabState[], projects: Array<{ cwd: string; hostId?: string }>): PaletteContext & { run: Record<keyof PaletteRunner, ReturnType<typeof vi.fn>> } {
  const run = {
    activateChat: vi.fn(),
    openProject: vi.fn(),
    openSession: vi.fn(),
    insertMention: vi.fn(),
    insertCommand: vi.fn(),
    runAction: vi.fn(),
    openLayer: vi.fn(),
    loadHistory: vi.fn()
  }
  return {
    sidebar: buildSidebar(tabs, projects.map((p) => ({ ...p, collapsed: false })), {}, [server]),
    activeTabId: tabs[0]?.id ?? '',
    files: [],
    commands: [],
    servers: [server],
    run
  }
}

describe('Ctrl+K и серверные проекты (R8)', () => {
  test('серверный проект без чатов открывается на своём сервере', () => {
    const c = ctx([], [{ cwd: '/srv/app', hostId: 'h1' }, { cwd: 'C:/work/app' }])
    const rows = projectsProvider.items('app', c)
    const remote = rows.find((r) => r.hint?.includes('Дом'))!
    remote.run()
    expect(c.run.openProject).toHaveBeenCalledWith('/srv/app', 'h1')
    const local = rows.find((r) => !r.hint?.includes('Дом'))!
    local.run()
    expect(c.run.openProject).toHaveBeenLastCalledWith('C:/work/app')
  })

  test('в подсказке проекта и чата — метка сервера', () => {
    const c = ctx([tab('t1', '/srv/app', 'Починка', 'h1'), tab('t2', '/srv/site', 'site', 'h1'), tab('t3', 'C:/w/app', 'Местный')], [])
    const projects = projectsProvider.items('', c, true)
    expect(projects.find((p) => p.title === 'app' && p.hint?.startsWith('Дом'))!.hint).toBe('Дом · /srv/app')
    const chats = chatsProvider.items('', c)
    expect(chats.find((r) => r.title === 'Починка')!.hint).toBe('Дом · app')
    // A chat named after its folder still says which server.
    expect(chats.find((r) => r.title === 'site')!.hint).toBe('Дом')
    expect(chats.find((r) => r.title === 'Местный')!.hint).toBe('app')
  })
})
