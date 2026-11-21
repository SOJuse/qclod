import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { BackgroundTask, RibbonItem } from '../../src/shared/types'
import { BackgroundTasks, TaskManagerList, counterTitle } from '../../src/renderer/components/BackgroundTasks'
import { cardForTask } from '../../src/renderer/agents/cardForTask'

const now = Date.now()
const command = (id: string, patch: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: id,
  kind: 'command',
  type: 'local_bash',
  description: 'dev server',
  command: `npm run ${id}`,
  status: 'running',
  startedAt: now - 5000,
  ...patch
})
const agent = (id: string, patch: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId: id,
  kind: 'agent',
  type: 'local_agent',
  subagentType: 'Explore',
  description: 'Найти конфиг сборки',
  summary: 'читает vite.config.ts',
  status: 'running',
  startedAt: now - 65_000,
  ...patch
})

const list = (tasks: BackgroundTask[], onOpenAgent?: (taskId: string) => void): string =>
  renderToStaticMarkup(
    createElement(TaskManagerList, { tabId: 't', tasks, ...(onOpenAgent ? { onOpenAgent } : {}) })
  )
const count = (html: string, needle: string): number => html.split(needle).length - 1

describe('TaskManagerList', () => {
  test('заголовок «Диспетчер задач»; группы «Агенты» и «Команды»', () => {
    const html = list([agent('a1'), command('dev')], () => undefined)
    expect(html).toContain('Диспетчер задач')
    expect(html).toMatch(/Агенты[^]*Команды/)
    expect(count(html, 'class="bg-group-title"')).toBe(2)
  })

  test('пустая группа не рисуется', () => {
    const onlyCommands = list([command('dev')])
    expect(onlyCommands).toContain('>Команды<')
    expect(onlyCommands).not.toContain('>Агенты<')
    const onlyAgents = list([agent('a1')], () => undefined)
    expect(onlyAgents).toContain('>Агенты<')
    expect(onlyAgents).not.toContain('>Команды<')
  })

  test('строка агента: тип, описание, сводка, время, состояние; «Открыть ленту», «Остановить», без вывода', () => {
    const html = list([agent('a1')], () => undefined)
    expect(html).toContain('Explore')
    expect(html).toContain('Найти конфиг сборки')
    expect(html).toContain('читает vite.config.ts')
    expect(html).toContain('1:05')
    expect(html).toContain('работает')
    expect(html).toContain('data-testid="bg-open-agent"')
    expect(html).toContain('Открыть ленту')
    expect(html).toContain('data-testid="bg-stop"')
    expect(html).not.toContain('data-testid="bg-task-toggle"')
    expect(html).not.toContain('Показать вывод')
  })

  test('агент назван теми же словами, что в графе: «готов», «остановлен»; команда — «готова»', () => {
    const html = list(
      [agent('a1', { status: 'completed', endedAt: now }), agent('a2', { status: 'stopped', endedAt: now }), command('dev', { status: 'completed', endedAt: now })],
      () => undefined
    )
    const agents = html.slice(0, html.indexOf('data-kind="command"'))
    const commands = html.slice(html.indexOf('data-kind="command"'))
    expect(agents).toContain('готов<')
    expect(agents).toContain('остановлен<')
    expect(agents).not.toContain('готова')
    expect(agents).not.toContain('остановлена')
    expect(commands).toContain('готова<')
  })

  test('без onOpenAgent нет «Открыть ленту»', () => {
    expect(list([agent('a1')])).not.toContain('Открыть ленту')
  })

  test('строка команды — как прежде: переключатель вывода и «Остановить»', () => {
    const html = list([command('dev')])
    expect(html).toContain('npm run dev')
    expect(html).toContain('data-testid="bg-task-toggle"')
    expect(html).toContain('data-testid="bg-stop"')
  })

  test('«Остановить все» при двух работающих, нет при одной', () => {
    expect(list([agent('a1'), command('dev')], () => undefined)).toContain('Остановить все')
    expect(list([agent('a1'), command('dev', { status: 'completed', endedAt: now })], () => undefined)).not.toContain(
      'Остановить все'
    )
  })

  test('пусто — «Фоновых задач нет»', () => {
    const html = list([])
    expect(html).toContain('Фоновых задач нет')
    expect(html).not.toContain('class="bg-group-title"')
  })
})

describe('BackgroundTasks — счётчик', () => {
  test('title: «Фоновые задачи: N работает» / «…: N, все закончились»', () => {
    expect(counterTitle(1, 3)).toBe('Фоновые задачи: 1 работает')
    expect(counterTitle(0, 3)).toBe('Фоновые задачи: 3, все закончились')
  })

  test('без задач счётчика нет; с задачами — «Фоновые N»', () => {
    expect(renderToStaticMarkup(createElement(BackgroundTasks, { tabId: 't', tasks: [] }))).toBe('')
    const html = renderToStaticMarkup(createElement(BackgroundTasks, { tabId: 't', tasks: [agent('a1'), command('dev')] }))
    expect(html).toContain('Фоновые 2')
    expect(html).toContain('title="Фоновые задачи: 2 работают"')
  })
})

describe('cardForTask — «Открыть ленту» находит карточку агента', () => {
  const sub = (id: string, patch: object): RibbonItem =>
    ({ kind: 'subagent', id, toolUseId: `tu-${id}`, name: 'Explore', task: '', state: 'running', summary: '', ...patch }) as never
  test('по taskId, иначе по agentId; нет — null', () => {
    const items = [sub('c1', { taskId: 't1' }), sub('c2', { agentId: 'a2' })]
    expect(cardForTask(items, 't1')).toBe('c1')
    expect(cardForTask(items, 'a2')).toBe('c2')
    expect(cardForTask(items, 'x')).toBeNull()
  })
})
