import { describe, expect, test, vi } from 'vitest'
import { PALETTE_PROVIDERS, paletteState, searchPalette, sectionTitle } from '../../src/renderer/palette/providers'
import { SECTION_CAP, type PaletteContext, type PaletteRunner } from '../../src/renderer/palette/types'
import { HISTORY_PREFETCH, historyToLoad } from '../../src/renderer/palette/history'
import { withMention } from '../../src/renderer/palette/files'
import { withCommand } from '../../src/renderer/palette/commands'
import { buildSidebar, type ProjectHistory } from '../../src/renderer/chat/sidebarModel'
import type { CommandInfo, ProjectEntry, SessionSummary, TabState } from '../../src/shared/types'

const tab = (id: string, cwd: string, title = id): TabState => ({
  id,
  cwd,
  title,
  overrides: {},
  status: 'idle',
  badge: false
})
const session = (id: string, updatedAt: number, title = id, firstMessage = ''): SessionSummary => ({
  id,
  title,
  firstMessage,
  updatedAt
})

function runner(): PaletteRunner & { [K in keyof PaletteRunner]: ReturnType<typeof vi.fn> } {
  return {
    activateChat: vi.fn(),
    openProject: vi.fn(),
    openSession: vi.fn(),
    insertMention: vi.fn(),
    insertCommand: vi.fn(),
    insertTemplate: vi.fn(),
    runAction: vi.fn(),
    openLayer: vi.fn(),
    loadHistory: vi.fn()
  }
}

function context(
  opts: {
    tabs?: TabState[]
    projects?: ProjectEntry[]
    history?: Record<string, ProjectHistory>
    files?: string[]
    commands?: CommandInfo[]
  } = {}
): PaletteContext & { run: ReturnType<typeof runner> } {
  const tabs = opts.tabs ?? [tab('a', 'C:\\work\\qclod', 'Починка палитры'), tab('b', 'C:\\work\\site', 'Вёрстка')]
  return {
    sidebar: buildSidebar(tabs, opts.projects ?? [], opts.history ?? {}),
    activeTabId: tabs[0]?.id ?? '',
    files: opts.files ?? [],
    commands: opts.commands ?? [],
    run: runner()
  }
}

const sections = (items: Array<{ section: string }>): string[] => [...new Set(items.map((i) => i.section))]

describe('Ctrl+K: поиск по всему', () => {
  test('пустой запрос: чаты, прошлые и команды', () => {
    const ctx = context({
      history: {
        'c:\\work\\qclod': {
          items: [1, 2, 3, 4, 5, 6, 7].map((n) => session(`s${n}`, n * 10))
        }
      },
      files: ['src/a.ts']
    })
    const items = searchPalette('', ctx)
    expect(sections(items)).toEqual(['chats', 'history', 'commands'])
    expect(items.filter((i) => i.section === 'chats').map((i) => i.title)).toEqual(['Починка палитры', 'Вёрстка'])
    // The five newest past ones, newest first.
    expect(items.filter((i) => i.section === 'history').map((i) => i.key.split(':').pop())).toEqual([
      's7',
      's6',
      's5',
      's4',
      's3'
    ])
    const commands = items.filter((i) => i.section === 'commands')
    expect(commands).toHaveLength(SECTION_CAP)
    expect(commands[0]).toMatchObject({ title: 'Новый чат', keys: 'Ctrl+T' })
  })

  test('префикс > — только команды', () => {
    const ctx = context({
      files: ['src/новый.ts'],
      commands: [{ name: 'compact', description: 'Сжать контекст', argumentHint: '' }]
    })
    const items = searchPalette('>нов', ctx)
    expect(sections(items)).toEqual(['commands'])
    expect(items[0]?.title).toBe('Новый чат')
    // A slash command of the active chat, as «/name — описание»; it goes into the input.
    const slash = searchPalette('> /comp', ctx)
    expect(slash[0]?.title).toBe('/compact — Сжать контекст')
    slash[0]!.run()
    expect(ctx.run.insertCommand).toHaveBeenCalledWith('compact')
  })

  test('префикс @ — только файлы', () => {
    const ctx = context({ files: ['src/renderer/palette/types.ts', 'README.md'] })
    const items = searchPalette('@types', ctx)
    expect(sections(items)).toEqual(['files'])
    expect(items[0]).toMatchObject({ title: 'types.ts', hint: 'src/renderer/palette' })
    // «@» alone lists the files, since the section is shown by itself.
    expect(searchPalette('@', ctx).map((i) => i.title)).toEqual(['types.ts', 'README.md'])
  })

  test('5000 файлов дают не больше 8 строк', () => {
    const files = Array.from({ length: 5000 }, (_, i) => `src/module${i}/index.ts`)
    const ctx = context({ files })
    const items = searchPalette('index', ctx)
    expect(items.filter((i) => i.section === 'files')).toHaveLength(SECTION_CAP)
    expect(searchPalette('@index', ctx)).toHaveLength(SECTION_CAP)
    for (const provider of PALETTE_PROVIDERS) {
      expect(searchPalette('', ctx, provider.section).length).toBeLessThanOrEqual(SECTION_CAP)
    }
  })

  test('прошлая сессия ищется по первому сообщению', () => {
    const ctx = context({
      history: {
        'c:\\work\\qclod': {
          items: [
            session('s1', 20, 'Починка вставки файлов', 'вставка файлов не работает'),
            session('s2', 10, 'Переезд на SDK', 'давай перепишем ядро')
          ]
        }
      }
    })
    const items = searchPalette('перепишем', ctx).filter((i) => i.section === 'history')
    expect(items.map((i) => i.title)).toEqual(['Переезд на SDK'])
    expect(items[0]?.hint).toContain('qclod')
    // Scattered letters across a long first message do not count.
    expect(searchPalette('пяд', ctx).filter((i) => i.section === 'history')).toEqual([])
    items[0]!.run()
    expect(ctx.run.openSession).toHaveBeenCalledWith('C:\\work\\qclod', expect.objectContaining({ id: 's2' }))
  })

  test('scope history без запроса — новые прошлые по убыванию updatedAt', () => {
    const ctx = context({
      projects: [{ cwd: 'D:\\old', collapsed: true }],
      history: {
        'c:\\work\\qclod': { items: [session('a', 30), session('b', 10)] },
        'c:\\work\\site': { items: [session('c', 40)] },
        'd:\\old': { items: [session('d', 20), ...[1, 2, 3, 4, 5, 6].map((n) => session(`old${n}`, n))] }
      }
    })
    const items = searchPalette('', ctx, 'history')
    expect(sections(items)).toEqual(['history'])
    // Every project, a folded one too; more than the mixed list's five, at most the cap.
    expect(items.map((i) => i.key.split(':').pop())).toEqual(['c', 'a', 'd', 'b', 'old6', 'old5', 'old4', 'old3'])
    // A prefix means nothing inside a scope: «>» is just text there.
    expect(searchPalette('>', ctx, 'history')).toEqual([])
  })

  test('файл вставляет @путь', () => {
    const ctx = context({ files: ['src/app.ts'] })
    const item = searchPalette('app', ctx).find((i) => i.section === 'files')
    item!.run()
    expect(ctx.run.insertMention).toHaveBeenCalledWith('src/app.ts')
    expect(withMention('', 'src/app.ts')).toBe('@src/app.ts ')
    expect(withMention('глянь', 'src/app.ts')).toBe('глянь @src/app.ts ')
    expect(withMention('глянь ', 'src/app.ts')).toBe('глянь @src/app.ts ')
    expect(withCommand('', 'compact')).toBe('/compact ')
    expect(withCommand('  про тесты', 'compact')).toBe('/compact про тесты')
  })

  test('проект без живого чата открывает новый', () => {
    const ctx = context({
      tabs: [tab('a', 'C:\\work\\qclod'), tab('b', 'C:\\work\\qclod')],
      projects: [{ cwd: 'C:\\work\\qclod', collapsed: false }, { cwd: 'C:\\work\\empty', collapsed: true }]
    })
    const empty = searchPalette('empty', ctx).find((i) => i.section === 'projects')
    empty!.run()
    expect(ctx.run.openProject).toHaveBeenCalledWith('C:\\work\\empty')
    expect(ctx.run.activateChat).not.toHaveBeenCalled()

    // With open chats, the last of them.
    searchPalette('qclod', ctx).find((i) => i.section === 'projects')!.run()
    expect(ctx.run.activateChat).toHaveBeenCalledWith('b')
  })

  test('чат ищется по названию и по имени проекта; команда окна запускается', () => {
    const ctx = context()
    expect(searchPalette('вёрст', ctx).filter((i) => i.section === 'chats').map((i) => i.title)).toEqual(['Вёрстка'])
    const bySite = searchPalette('site', ctx).filter((i) => i.section === 'chats')
    expect(bySite.map((i) => i.title)).toEqual(['Вёрстка'])
    bySite[0]!.run()
    expect(ctx.run.activateChat).toHaveBeenCalledWith('b')

    const settings = searchPalette('настр', ctx)[0]
    expect(settings).toMatchObject({ section: 'commands', title: 'Настройки', keys: 'Ctrl+,' })
    settings!.run()
    expect(ctx.run.runAction).toHaveBeenCalledWith('settings')
    // Ctrl+K has no row of its own: the palette is what is open.
    expect(searchPalette('палитр', ctx).filter((i) => i.key === 'action:actions')).toEqual([])
  })

  test('заголовки разделов — из источников; при открытии догружается история не больше 20 проектов', () => {
    expect(PALETTE_PROVIDERS.map((p) => [p.section, p.title])).toEqual([
      ['chats', 'Чаты'],
      ['projects', 'Проекты'],
      ['history', 'Прошлые разговоры'],
      ['files', 'Файлы'],
      ['commands', 'Команды'],
      ['templates', 'Шаблоны'],
      ['historyText', 'В разговорах']
    ])
    expect(sectionTitle('history')).toBe('Прошлые разговоры')

    const projects = Array.from({ length: 30 }, (_, i) => ({ cwd: `C:\\p${i}`, collapsed: true }))
    const sidebar = buildSidebar([], projects, { 'c:\\p0': { items: [] }, 'c:\\p1': 'loading' })
    const asked = historyToLoad(sidebar)
    expect(asked).toHaveLength(HISTORY_PREFETCH)
    // Asked once already (read, or being read): not again.
    expect(asked[0]).toBe('C:\\p2')
  })
})

describe('Ctrl+K: раздел, который ещё читается или не прочитался (Fix round 1)', () => {
  test('Ctrl+H, пока история читается, — «загрузка», а не «ничего не нашлось»; в общем списке — ничего', () => {
    const ctx = context({ history: { 'c:\\work\\qclod': 'loading' } })
    expect(searchPalette('', ctx, 'history')).toEqual([])
    expect(paletteState('', ctx, 'history')).toEqual({ kind: 'loading' })
    expect(paletteState('sdk', ctx, 'history')).toEqual({ kind: 'loading' })
    // The mixed list has other sections: no section speaks for it.
    expect(paletteState('', ctx)).toBeNull()
  })

  test('чтение упало — ошибка с причиной, «Повторить» перечитывает каждый упавший проект', () => {
    const ctx = context({
      history: {
        'c:\\work\\qclod': { items: [], error: 'нет доступа' },
        'c:\\work\\site': { items: [], error: 'диск отключён' }
      }
    })
    const state = paletteState('', ctx, 'history')
    expect(state).toMatchObject({ kind: 'error', title: 'Не удалось прочитать историю', reason: 'нет доступа' })
    if (state?.kind === 'error') state.retry()
    expect(ctx.run.loadHistory.mock.calls).toEqual([['C:\\work\\qclod'], ['C:\\work\\site']])
  })

  test('всё прочитано и пусто — состояния нет, это «Ничего не нашлось»', () => {
    const ctx = context({ history: { 'c:\\work\\qclod': { items: [] }, 'c:\\work\\site': { items: [] } } })
    expect(paletteState('', ctx, 'history')).toBeNull()
  })

  test('@, пока индекс файлов не пришёл, — «загрузка»', () => {
    const ctx = { ...context(), filesPending: true }
    expect(searchPalette('@', ctx)).toEqual([])
    expect(paletteState('@', ctx)).toEqual({ kind: 'loading' })
    expect(paletteState('@', { ...ctx, filesPending: false })).toBeNull()
  })

  test('ё и е ищутся одинаково — и в запросе, и в тексте', () => {
    const ctx = context()
    expect(searchPalette('верстка', ctx).filter((i) => i.section === 'chats').map((i) => i.title)).toEqual(['Вёрстка'])
    expect(searchPalette('ВЁРСТ', ctx).filter((i) => i.section === 'chats').map((i) => i.title)).toEqual(['Вёрстка'])
    const past = context({
      history: { 'c:\\work\\qclod': { items: [session('s1', 1, 'Разное', 'пришлёт ли ещё')] } }
    })
    expect(searchPalette('пришлет', past).filter((i) => i.section === 'history')).toHaveLength(1)
  })
})
