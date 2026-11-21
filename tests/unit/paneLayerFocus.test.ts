// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PaneLayer } from '../../src/renderer/components/PaneLayer'
import { AgentsLayer } from '../../src/renderer/components/agents/AgentsLayer'
import { AgentView } from '../../src/renderer/components/agents/AgentView'
import { BackgroundTasks } from '../../src/renderer/components/BackgroundTasks'
import type { BackgroundTask, RibbonItem, SubagentStopResult } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Sub = Extract<RibbonItem, { kind: 'subagent' }>
const sub = (patch: Partial<Sub> = {}): Sub => ({
  kind: 'subagent',
  id: 'a',
  toolUseId: 'tu-a',
  name: 'Explore',
  task: 'Обзор',
  state: 'running',
  summary: '',
  taskId: 'ta',
  ...patch
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  // jsdom has neither; the ribbon and the graph ask for them.
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Element.prototype.scrollIntoView ??= function (): void {}
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  delete (window as { qclod?: unknown }).qclod
})

const q = <T extends HTMLElement = HTMLElement>(sel: string): T => host.querySelector<T>(sel)!

/** An opener and, when open, the layer with `body` — as ChatPane draws it. */
function Harness({ body }: { body: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(false)
  return createElement(
    'div',
    null,
    createElement('button', { 'data-testid': 'opener', onClick: () => setOpen(true) }, 'Агенты'),
    open ? createElement(PaneLayer, { title: 'Агенты', onClose: () => setOpen(false), children: body }) : null
  )
}

function openAndClose(body: ReactNode): void {
  act(() => root.render(createElement(Harness, { body })))
  act(() => q('[data-testid="opener"]').focus())
  act(() => q('[data-testid="opener"]').click())
  // The body put the focus on a control of its own.
  expect(q('[data-testid="pane-layer"]').contains(document.activeElement)).toBe(true)
  act(() => q('[data-testid="pane-layer-close"]').click())
}

describe('PaneLayer: фокус после закрытия', () => {
  test('граф: фокус возвращается на открывателя, а не на body', () => {
    openAndClose(createElement(AgentsLayer, { tabId: 't', items: [sub()], costRates: null }))
    expect(document.activeElement).toBe(q('[data-testid="opener"]'))
  })

  test('лента агента: фокус возвращается на открывателя', () => {
    const card = sub()
    openAndClose(createElement(AgentsLayer, { tabId: 't', items: [card], costRates: null, agentId: card.id }))
    expect(document.activeElement).toBe(q('[data-testid="opener"]'))
  })

  test('«Открыть ленту» из диспетчера: после закрытия слоя фокус на счётчике «Фоновые»', () => {
    const task: BackgroundTask = {
      taskId: 'ta',
      kind: 'agent',
      type: 'local_agent',
      description: 'Обзор',
      status: 'running',
      startedAt: Date.now()
    }
    function Dispatcher(): JSX.Element {
      const [open, setOpen] = useState(false)
      return createElement(
        'div',
        null,
        createElement(BackgroundTasks, { tabId: 't', tasks: [task], onOpenAgent: () => setOpen(true) }),
        open
          ? createElement(PaneLayer, {
              title: 'Агенты',
              onClose: () => setOpen(false),
              children: createElement(AgentsLayer, { tabId: 't', items: [sub()], costRates: null, agentId: 'a' })
            })
          : null
      )
    }
    act(() => root.render(createElement(Dispatcher)))
    act(() => q('[data-testid="status-bg"]').click())
    act(() => q('[data-testid="bg-open-agent"]').focus())
    act(() => q('[data-testid="bg-open-agent"]').click())
    expect(host.querySelector('[data-testid="bg-list"]')).toBeNull()
    expect(q('[data-testid="pane-layer"]').contains(document.activeElement)).toBe(true)
    act(() => q('[data-testid="pane-layer-close"]').click())
    expect(document.activeElement).toBe(q('[data-testid="status-bg"]'))
  })
})

describe('AgentView: «Остановить»', () => {
  function stopWith(answer: () => Promise<SubagentStopResult>): ReturnType<typeof vi.fn> {
    const stopSubagent = vi.fn(answer)
    ;(window as { qclod?: unknown }).qclod = { stopSubagent }
    return stopSubagent
  }
  const render = (card: Sub): void =>
    act(() => root.render(createElement(AgentView, { tabId: 't', card, items: [card], costRates: null, onBack: () => undefined })))
  const button = (): HTMLButtonElement => q<HTMLButtonElement>('[data-testid="agent-stop"]')

  test('ответ stopping: кнопка неактивна «Останавливаю…», пока агент работает', async () => {
    const stop = stopWith(async () => 'stopping')
    render(sub())
    await act(async () => button().click())
    expect(stop).toHaveBeenCalledTimes(1)
    expect(button().disabled).toBe(true)
    expect(button().textContent).toContain('Останавливаю…')
    // Still running a while later: still disabled.
    render(sub({ summary: 'ещё работает' }))
    expect(button().disabled).toBe(true)
    // It ends: the button goes; running again (a resumed run) — ready afresh.
    render(sub({ state: 'stopped' }))
    expect(host.querySelector('[data-testid="agent-stop"]')).toBeNull()
    render(sub({ runs: 2 }))
    expect(button().disabled).toBe(false)
    expect(button().textContent).toContain('Остановить')
  })

  test('failed / исключение: кнопка снова активна, причина видна', async () => {
    stopWith(async () => 'failed')
    render(sub())
    await act(async () => button().click())
    expect(button().disabled).toBe(false)
    expect(q('[data-testid="agent-stop-error"]').textContent).toBe('Не удалось остановить')

    stopWith(async () => {
      throw new Error('нет')
    })
    await act(async () => button().click())
    expect(button().disabled).toBe(false)
  })
})

describe('Диспетчер: «Остановить все»', () => {
  test('в процессе: неактивна «Останавливаю…», повторно не шлёт', async () => {
    const stopTask = vi.fn(async () => undefined)
    ;(window as { qclod?: unknown }).qclod = { stopTask }
    const task = (id: string, status: BackgroundTask['status'] = 'running'): BackgroundTask => ({
      taskId: id,
      kind: 'command',
      type: 'local_bash',
      description: id,
      status,
      startedAt: Date.now()
    })
    const render = (tasks: BackgroundTask[]): void => act(() => root.render(createElement(BackgroundTasks, { tabId: 't', tasks })))
    render([task('b1'), task('b2')])
    act(() => q('[data-testid="status-bg"]').click())
    const all = (): HTMLButtonElement => q<HTMLButtonElement>('[data-testid="bg-stop-all"]')
    await act(async () => all().click())
    expect(stopTask).toHaveBeenCalledTimes(2)
    expect(all().disabled).toBe(true)
    expect(all().textContent).toContain('Останавливаю…')
    await act(async () => all().click())
    expect(stopTask).toHaveBeenCalledTimes(2)
    // All ended: the button goes; two running again later — it is ready afresh.
    render([task('b1', 'stopped'), task('b2', 'stopped')])
    expect(host.querySelector('[data-testid="bg-stop-all"]')).toBeNull()
    render([task('b1', 'stopped'), task('b2', 'stopped'), task('b3'), task('b4')])
    expect(all().disabled).toBe(false)
  })
})

describe('AgentsLayer: прокрутка к работающему', () => {
  test('при открытии и смене вида — к первому работающему узлу, без работающих — к корню', () => {
    const calls: Array<{ el: Element; opts: unknown }> = []
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element, opts?: unknown) {
      calls.push({ el: this, opts })
    })
    const items: RibbonItem[] = Array.from({ length: 15 }, (_, i) =>
      sub({ id: `n${i}`, toolUseId: `tu${i}`, state: i === 9 ? 'running' : 'done', startedAt: Date.now() - (15 - i) * 1000 })
    )
    act(() => root.render(createElement(AgentsLayer, { tabId: 't', items, costRates: null })))
    expect(calls.at(-1)?.el.getAttribute('data-node-id')).toBe('n9')
    expect(calls.at(-1)?.opts).toMatchObject({ block: 'center' })

    act(() => q('[data-testid="agents-view-timeline"]').click())
    expect(calls.at(-1)?.el.getAttribute('data-node-id')).toBe('n9')
    expect(calls.at(-1)?.el.getAttribute('data-testid')).toBe('agent-row')
    act(() => q('[data-testid="agents-view-graph"]').click())

    // A tick of the clock or a new step does not pull the view back.
    const before = calls.length
    act(() => root.render(createElement(AgentsLayer, { tabId: 't', items: [...items], costRates: null })))
    expect(calls).toHaveLength(before)

    act(() => root.unmount())
    root = createRoot(host)
    const idle = items.map((i) => ({ ...i, state: 'done' }) as RibbonItem)
    act(() => root.render(createElement(AgentsLayer, { tabId: 't', items: idle, costRates: null })))
    expect(calls.at(-1)?.el.getAttribute('data-testid')).toBe('agent-graph-root')
  })
})
