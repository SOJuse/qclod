import { describe, expect, test } from 'vitest'
import { RibbonBuilder, parseTaskNotifications } from '../../src/shared/ribbon'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import type { RibbonItem } from '../../src/shared/types'

// Message shapes below are the SDK's own, taken from node_modules/.../sdk.d.ts
// and from the live probe (docs/superpowers/notes/2026-11-07-sdk-probe-results.md).
// A fixture that lies is worse than no fixture.

let seq = 0
const uuid = (): string => `u${++seq}`

function assistant(content: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'assistant',
    uuid: uuid(),
    session_id: 's1',
    parent_tool_use_id: null,
    message: { id: `msg_${seq}`, role: 'assistant', content },
    ...extra
  }
}

function userMessage(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'user',
    uuid: uuid(),
    session_id: 's1',
    parent_tool_use_id: null,
    message: { role: 'user', content },
    ...extra
  }
}

function toolResult(toolUseId: string, content: string, isError = false): unknown {
  return userMessage([{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }])
}

function textDelta(messageId: string, text: string): unknown {
  return {
    type: 'stream_event',
    uuid: uuid(),
    session_id: 's1',
    parent_tool_use_id: null,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text }
    },
    message_id: messageId
  }
}

function messageStart(messageId: string): unknown {
  return {
    type: 'stream_event',
    uuid: uuid(),
    session_id: 's1',
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } }
  }
}

function only<K extends RibbonItem['kind']>(items: RibbonItem[], kind: K): Array<RibbonItem & { kind: K }> {
  return items.filter((i) => i.kind === kind) as Array<RibbonItem & { kind: K }>
}

describe('RibbonBuilder', () => {
  test('текст агента дописывается в один элемент, а не плодит новые', () => {
    const b = new RibbonBuilder()
    b.apply(messageStart('msg_a'))
    b.apply(textDelta('msg_a', 'Привет'))
    b.apply(textDelta('msg_a', ', мир'))

    const texts = only(b.items, 'agentText')
    expect(texts).toHaveLength(1)
    expect(texts[0]!.text).toBe('Привет, мир')
    expect(texts[0]!.streaming).toBe(true)

    // The complete assistant message always follows a stream and must not
    // duplicate what the deltas already showed.
    b.apply(
      assistant([{ type: 'text', text: 'Привет, мир' }], {
        message: { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text: 'Привет, мир' }] }
      })
    )

    const after = only(b.items, 'agentText')
    expect(after).toHaveLength(1)
    expect(after[0]!.text).toBe('Привет, мир')
    expect(after[0]!.streaming).toBe(false)
  })

  test('вызов инструмента и его результат — один элемент, а не два', () => {
    const b = new RibbonBuilder()
    b.apply(assistant([{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/p/auth.ts' } }]))

    let tools = only(b.items, 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.name).toBe('Read')
    expect(tools[0]!.target).toBe('auth.ts')
    expect(tools[0]!.state).toBe('running')

    const changes = b.apply(toolResult('t1', 'строка 1\nстрока 2\nстрока 3'))
    expect(changes).toEqual([
      { kind: 'update', id: tools[0]!.id, patch: { state: 'done', summary: '3 строки', detail: 'строка 1\nстрока 2\nстрока 3' } }
    ])

    tools = only(b.items, 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.state).toBe('done')
    expect(b.items).toHaveLength(1)
  })

  test('ошибка инструмента даёт элемент toolError с текстом ошибки', () => {
    const b = new RibbonBuilder()
    b.apply(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]))
    b.apply(toolResult('t1', 'npm ERR! тесты упали', true))

    expect(only(b.items, 'tool')).toHaveLength(0)
    const errors = only(b.items, 'toolError')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.name).toBe('Bash')
    expect(errors[0]!.target).toBe('npm test')
    expect(errors[0]!.error).toBe('npm ERR! тесты упали')
  })

  test('размышления сворачиваются в один элемент с длительностью', () => {
    let clock = 1000
    const b = new RibbonBuilder({ now: () => clock })

    b.apply(messageStart('msg_t'))
    b.apply({
      type: 'stream_event',
      uuid: uuid(),
      session_id: 's1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'взвешиваю' } }
    })
    clock = 4500
    b.apply({
      type: 'stream_event',
      uuid: uuid(),
      session_id: 's1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' варианты' } }
    })
    clock = 6000
    b.apply(assistant([{ type: 'text', text: 'готово' }]))

    const thinking = only(b.items, 'thinking')
    expect(thinking).toHaveLength(1)
    expect(thinking[0]!.text).toBe('взвешиваю варианты')
    expect(thinking[0]!.done).toBe(true)
    expect(thinking[0]!.durationMs).toBe(5000)
  })

  test('TodoWrite не попадает в ленту, а обновляет список задач', () => {
    const b = new RibbonBuilder()
    const changes = b.apply(
      assistant([
        {
          type: 'tool_use',
          id: 't1',
          name: 'TodoWrite',
          input: { todos: [{ content: 'починить вставку', status: 'in_progress', activeForm: 'чиню вставку' }] }
        }
      ])
    )

    expect(changes).toEqual([
      { kind: 'todo', items: [{ content: 'починить вставку', status: 'in_progress' }] }
    ])
    expect(b.items).toHaveLength(0)
    expect(b.todo).toEqual([{ content: 'починить вставку', status: 'in_progress' }])

    // Its result must not leave an orphan card behind either.
    b.apply(toolResult('t1', 'ok'))
    expect(b.items).toHaveLength(0)
  })

  test('повторный TodoWrite заменяет список целиком, а не дублирует', () => {
    const b = new RibbonBuilder()
    b.apply(
      assistant([
        { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'раз', status: 'pending' }] } }
      ])
    )
    b.apply(
      assistant([
        {
          type: 'tool_use',
          id: 't2',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'раз', status: 'completed' },
              { content: 'два', status: 'in_progress' }
            ]
          }
        }
      ])
    )

    expect(b.todo).toEqual([
      { content: 'раз', status: 'completed' },
      { content: 'два', status: 'in_progress' }
    ])
    expect(b.items).toHaveLength(0)
  })

  test('Task даёт элемент subagent, его вложенные инструменты — внутрь него', () => {
    const b = new RibbonBuilder()
    b.apply(
      assistant([
        { type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'найти утечку', subagent_type: 'Explore' } }
      ])
    )

    const subagents = only(b.items, 'subagent')
    expect(subagents).toHaveLength(1)
    // What it is, and separately what it was asked to do.
    expect(subagents[0]!.name).toBe('Explore')
    expect(subagents[0]!.task).toBe('найти утечку')
    expect(subagents[0]!.state).toBe('running')

    b.apply(
      assistant([{ type: 'tool_use', id: 'n1', name: 'Grep', input: { pattern: 'leak' } }], {
        parent_tool_use_id: 'task1'
      })
    )

    const nested = only(b.items, 'tool')
    expect(nested).toHaveLength(1)
    expect(nested[0]!.parentId).toBe(subagents[0]!.id)

    b.apply(toolResult('task1', 'подагент закончил'))
    expect(only(b.items, 'subagent')[0]!.state).toBe('done')
    expect(only(b.items, 'subagent')[0]!.summary).toBe('подагент закончил')
  })

  test('AskUserQuestion даёт элемент question с вариантами, а не permission', () => {
    const b = new RibbonBuilder()
    b.apply(
      assistant([
        {
          type: 'tool_use',
          id: 'q1',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Какой вариант панели?',
                header: 'Панель',
                options: [
                  { label: 'Справа', description: 'как в приложении' },
                  { label: 'Снизу', description: 'как в терминале' }
                ]
              }
            ]
          }
        }
      ])
    )

    expect(only(b.items, 'permission')).toHaveLength(0)
    const questions = only(b.items, 'question')
    expect(questions).toHaveLength(1)
    expect(questions[0]!.toolUseId).toBe('q1')
    expect(questions[0]!.question).toBe('Какой вариант панели?')
    expect(questions[0]!.options).toEqual(['Справа', 'Снизу'])
    expect(questions[0]!.answer).toBeNull()
  })

  test('compact_boundary даёт элемент compaction с числом освобождённых токенов', () => {
    const b = new RibbonBuilder()
    const changes = b.apply({
      type: 'system',
      subtype: 'compact_boundary',
      uuid: uuid(),
      session_id: 's1',
      compact_metadata: { trigger: 'auto', pre_tokens: 150000, post_tokens: 42000, duration_ms: 1200 }
    })

    expect(changes).toHaveLength(1)
    const item = only(b.items, 'compaction')[0]!
    expect(item.trigger).toBe('auto')
    expect(item.freedTokens).toBe(108000)
  })

  test('реплика пользователя попадает в ленту, а tool_result — нет', () => {
    const b = new RibbonBuilder()
    b.apply(userMessage('сделай рефактор auth.ts'))
    b.apply(userMessage([{ type: 'text', text: 'и прогони тесты' }]))

    const users = only(b.items, 'user')
    expect(users).toHaveLength(2)
    expect(users[0]!.text).toBe('сделай рефактор auth.ts')
    expect(users[1]!.text).toBe('и прогони тесты')
  })

  test('неизвестный тип сообщения игнорируется и не роняет сборку', () => {
    const b = new RibbonBuilder()
    expect(b.apply({ type: 'session_state_changed', uuid: uuid(), session_id: 's1' })).toEqual([])
    expect(b.apply({ type: 'hook_started' })).toEqual([])
    expect(b.apply({})).toEqual([])
    expect(b.apply(null)).toEqual([])
    expect(b.apply('мусор')).toEqual([])
    expect(b.items).toHaveLength(0)
  })

  test('результат хода закрывает открытый поток текста', () => {
    const b = new RibbonBuilder()
    b.apply(messageStart('msg_r'))
    b.apply(textDelta('msg_r', 'думаю вслух'))
    expect(only(b.items, 'agentText')[0]!.streaming).toBe(true)

    b.apply({ type: 'result', subtype: 'success', uuid: uuid(), session_id: 's1', is_error: false })
    expect(only(b.items, 'agentText')[0]!.streaming).toBe(false)
  })

  test('каждое изменение ссылается на существующий элемент', () => {
    const b = new RibbonBuilder()
    const changes = [
      ...b.apply(assistant([{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } }])),
      ...b.apply(toolResult('t1', 'ok'))
    ]

    for (const change of changes) {
      if (change.kind === 'update') {
        expect(b.items.some((i) => i.id === change.id)).toBe(true)
      }
      if (change.kind === 'append') {
        expect(b.items.some((i) => i.id === change.item.id)).toBe(true)
      }
    }
  })
})

describe('RibbonBuilder: эхо пользовательских сообщений', () => {
  test('эхо уже показанной реплики не создаёт вторую копию', () => {
    const b = new RibbonBuilder()
    b.addUser('сделай рефактор auth.ts')
    expect(only(b.items, 'user')).toHaveLength(1)

    // The CLI echoes every message back; the user already sees their own words.
    const changes = b.apply(userMessage('сделай рефактор auth.ts'))
    expect(changes).toEqual([])
    expect(only(b.items, 'user')).toHaveLength(1)
  })

  test('эхо гасится один раз — повторённая реплика видна дважды', () => {
    const b = new RibbonBuilder()
    b.addUser('ещё раз')
    b.apply(userMessage('ещё раз'))
    b.apply(userMessage('ещё раз'))

    expect(only(b.items, 'user')).toHaveLength(2)
  })

  test('реплика из истории показывается, её никто не гасил', () => {
    const b = new RibbonBuilder()
    b.apply(userMessage('это пришло из истории'))
    expect(only(b.items, 'user')).toHaveLength(1)
  })
})

describe('RibbonBuilder: мусор, вставленный не пользователем', () => {
  test('system-reminder не попадает в ленту', () => {
    const b = new RibbonBuilder()
    b.apply(
      userMessage(
        'посмотри auth.ts\n<system-reminder>Это напоминание системы, не ответ пользователю.</system-reminder>'
      )
    )

    const users = only(b.items, 'user')
    expect(users).toHaveLength(1)
    expect(users[0]!.text).toBe('посмотри auth.ts')
  })

  test('сообщение целиком из вставок не создаёт пустой реплики', () => {
    const b = new RibbonBuilder()
    b.apply(userMessage('<system-reminder>только напоминание</system-reminder>'))
    b.apply(userMessage('<local-command-stdout>вывод команды</local-command-stdout>'))

    expect(only(b.items, 'user')).toHaveLength(0)
  })

  test('оборванная вставка не тянет за собой хвост', () => {
    // A resumed transcript can be cut mid-block.
    const b = new RibbonBuilder()
    b.apply(userMessage('сделай рефактор\n<system-reminder>начало напоминания без конца'))

    expect(only(b.items, 'user')[0]!.text).toBe('сделай рефактор')
  })

  test('то же самое в блоках, а не в строке', () => {
    const b = new RibbonBuilder()
    b.apply(
      userMessage([
        { type: 'text', text: 'привет' },
        { type: 'text', text: '<system-reminder>шум</system-reminder>' }
      ])
    )

    expect(only(b.items, 'user')[0]!.text).toBe('привет')
  })
})

describe('RibbonBuilder: цифры подагента', () => {
  test('по окончании видно сколько времени и токенов он съел', () => {
    const b = new RibbonBuilder()
    b.apply(
      assistant([
        {
          type: 'tool_use',
          id: 'task1',
          name: 'Task',
          input: { description: 'найти утечку', subagent_type: 'Explore' }
        }
      ])
    )

    b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 'task1', content: 'нашёл в трёх местах' }], {
        tool_use_result: {
          totalDurationMs: 42000,
          totalTokens: 15000,
          totalToolUseCount: 7
        }
      })
    )

    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('done')
    expect(card.durationMs).toBe(42000)
    expect(card.tokens).toBe(15000)
    expect(card.toolCalls).toBe(7)
  })

  test('без цифр карточка просто без них, а не с нулями', () => {
    const b = new RibbonBuilder()
    b.apply(
      assistant([{ type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'что-то' } }])
    )
    b.apply(toolResult('task1', 'готово'))

    const card = only(b.items, 'subagent')[0]!
    expect(card.tokens).toBeUndefined()
    expect(card.toolCalls).toBeUndefined()
  })
})

describe('RibbonBuilder: подагент называется Agent', () => {
  test('Agent даёт карточку подагента, а не обычный вызов', () => {
    // The tool is «Agent» in this SDK; «Task» does not exist in it.
    const b = new RibbonBuilder()
    b.apply(
      assistant([
        {
          type: 'tool_use',
          id: 'a1',
          name: 'Agent',
          input: { description: 'перебрать зависимости', subagent_type: 'Explore' }
        }
      ])
    )

    const cards = only(b.items, 'subagent')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.name).toBe('Explore')
    expect(cards[0]!.task).toBe('перебрать зависимости')
    expect(only(b.items, 'tool')).toHaveLength(0)
  })

  test('его вложенные вызовы уходят внутрь карточки', () => {
    const b = new RibbonBuilder()
    b.apply(
      assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'искать' } }])
    )
    b.apply(
      assistant([{ type: 'tool_use', id: 'n1', name: 'Grep', input: { pattern: 'x' } }], {
        parent_tool_use_id: 'a1'
      })
    )

    const card = only(b.items, 'subagent')[0]!
    expect(only(b.items, 'tool')[0]!.parentId).toBe(card.id)
  })

  test('без subagent_type в имени остаётся понятное слово', () => {
    const b = new RibbonBuilder()
    b.apply(
      assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'что-то' } }])
    )
    expect(only(b.items, 'subagent')[0]!.name).toBe('подагент')
  })
})

describe('RibbonBuilder: время подагента', () => {
  test('если инструмент не сказал длительность, её меряет лента', () => {
    // The real Agent output carries tokens but no duration.
    let clock = 1000
    const b = new RibbonBuilder({ now: () => clock })
    b.apply(
      assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'искать' } }])
    )

    clock = 26000
    b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 'a1', content: 'нашёл' }], {
        tool_use_result: { totalTokens: 29000 }
      })
    )

    const card = only(b.items, 'subagent')[0]!
    expect(card.durationMs).toBe(25000)
    expect(card.tokens).toBe(29000)
  })

  test('если длительность пришла, она сильнее нашей', () => {
    let clock = 1000
    const b = new RibbonBuilder({ now: () => clock })
    b.apply(
      assistant([{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'искать' } }])
    )

    clock = 99000
    b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 'a1', content: 'нашёл' }], {
        tool_use_result: { totalDurationMs: 42000 }
      })
    )

    expect(only(b.items, 'subagent')[0]!.durationMs).toBe(42000)
  })
})

// Messages from a run of the fake SDK, which plays the CLI's real shapes.
async function played(steps: object[]): Promise<unknown[]> {
  const driver = createFakeSdk({ steps: steps as never })
  const out: unknown[] = []
  for await (const m of driver.messages) {
    out.push(m)
    if ((m as Record<string, unknown>)['type'] === 'result') break
  }
  return out
}

describe('RibbonBuilder: подагент по сообщениям фейка', () => {
  test('фоновый подагент после async_launched всё ещё работает', async () => {
    const b = new RibbonBuilder()
    for (const m of await played([{ kind: 'backgroundAgent', name: 'Прогон тестов', finish: null }])) b.apply(m)

    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('running')
    expect(card.background).toBe(true)
    expect(card.agentId).toEqual(expect.stringMatching(/^a[0-9a-f]{16}$/))
    expect(card.summary).not.toContain('Async agent launched')
  })

  test('итоги подагента читаются из totalTokens/totalDurationMs/totalToolUseCount', async () => {
    const b = new RibbonBuilder()
    const steps = [
      {
        kind: 'subagent',
        name: 'Обзор',
        stats: { totalTokens: 18000, totalDurationMs: 42000, totalToolUseCount: 7 },
        steps: []
      }
    ]
    for (const m of await played(steps)) b.apply(m)

    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('done')
    expect(card.tokens).toBe(18000)
    expect(card.durationMs).toBe(42000)
    expect(card.toolCalls).toBe(7)
  })

  test('упавший подагент остаётся подагентом со статусом failed', async () => {
    const b = new RibbonBuilder()
    const steps = [
      {
        kind: 'toolError',
        name: 'Agent',
        input: { description: 'Сборка', subagent_type: 'builder' },
        error: 'Agent type "builder" not found'
      }
    ]
    for (const m of await played(steps)) b.apply(m)

    const cards = only(b.items, 'subagent')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.state).toBe('failed')
    expect(cards[0]!.summary.startsWith('Agent type')).toBe(true)
    expect(only(b.items, 'toolError')).toHaveLength(0)
  })

  test('подагент, работавший при закрытии, — не закончил', async () => {
    const b = new RibbonBuilder()
    for (const m of await played([{ kind: 'backgroundAgent', name: 'Прогон тестов', finish: null }])) b.apply(m)
    b.closeOpen()

    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('unfinished')
    expect(card.summary).toBe('не закончил')
  })
})

const FINISH = { status: 'completed', summary: 'готово', tokens: 900, toolUses: 4, durationMs: 8000 }
const PROGRESS = [
  { tokens: 300, toolUses: 1, durationMs: 1000, lastTool: 'Read' },
  { tokens: 500, toolUses: 2, durationMs: 3000, lastTool: 'Bash' }
]

function agentStep(extra: Record<string, unknown>): object {
  return { kind: 'backgroundAgent', name: 'Прогон тестов', ...extra }
}

/** Plays the steps through the fake and returns everything it said, past the turn's result. */
async function playedToEnd(steps: object[], stopAt = '</task-notification>'): Promise<unknown[]> {
  const driver = createFakeSdk({ steps: steps as never })
  const out: unknown[] = []
  let resultSeen = false
  for await (const m of driver.messages) {
    out.push(m)
    if ((m as Record<string, unknown>)['type'] === 'result') resultSeen = true
    if (resultSeen && JSON.stringify(m).includes(stopAt)) break
  }
  return out
}

function feed(b: RibbonBuilder, messages: unknown[]): void {
  for (const m of messages) b.apply(m)
}

const bubbles = (b: RibbonBuilder): string[] => only(b.items, 'user').map((u) => u.text)

const isNoticeMessage = (m: unknown): boolean => {
  const r = m as Record<string, unknown>
  return r['type'] === 'user' && typeof r['origin'] === 'object'
}

describe('RibbonBuilder: события задач подагента', () => {
  test('task_progress обновляет токены, число инструментов и последний инструмент', async () => {
    const b = new RibbonBuilder()
    feed(b, await playedToEnd([agentStep({ progress: PROGRESS, finish: null })], '"total_tokens":500'))
    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('running')
    expect(card.tokens).toBe(500)
    expect(card.toolCalls).toBe(2)
    expect(card.lastTool).toBe('Bash')
    expect(card.taskId).toEqual(expect.stringMatching(/^a[0-9a-f]{16}$/))
  })

  test('task_notification закрывает карточку с итогом', async () => {
    const b = new RibbonBuilder()
    feed(b, await playedToEnd([agentStep({ progress: PROGRESS, finish: FINISH })]))
    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('done')
    expect(card.summary).toBe('готово')
    expect(card.tokens).toBe(900)
    expect(card.toolCalls).toBe(4)
    expect(card.lastTool).toBeUndefined()
  })

  test('уведомление failed и stopped дают свои статусы', async () => {
    for (const [status, state] of [
      ['failed', 'failed'],
      ['stopped', 'stopped']
    ] as const) {
      const b = new RibbonBuilder()
      feed(b, await playedToEnd([agentStep({ finish: { ...FINISH, status } })]))
      expect(only(b.items, 'subagent')[0]!.state).toBe(state)
    }
  })

  test('уведомление пользователем не показывается', async () => {
    const b = new RibbonBuilder()
    feed(b, await playedToEnd([agentStep({ finish: FINISH })]))
    expect(only(b.items, 'subagent')).toHaveLength(1)
    for (const text of bubbles(b)) {
      expect(text).not.toContain('task-notification')
      expect(text).not.toContain('Прогон тестов')
    }
  })

  test('уведомление только сообщением пользователя тоже закрывает карточку', async () => {
    const b = new RibbonBuilder()
    const all = await playedToEnd([agentStep({ finish: { ...FINISH, tokens: 93175 } })])
    feed(b, all.filter((m) => (m as Record<string, unknown>)['subtype'] !== 'task_notification'))
    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('done')
    expect(card.tokens).toBe(93175)
    expect(bubbles(b)).toEqual([])
  })

  test('result посреди работы фонового агента не закрывает его', async () => {
    const b = new RibbonBuilder()
    feed(b, await played([agentStep({ finish: null })]))
    b.apply({ type: 'result', subtype: 'success' })
    expect(only(b.items, 'subagent')[0]!.state).toBe('running')
  })

  test('background_tasks_changed без агента в списке не меняет состояние', async () => {
    const b = new RibbonBuilder()
    feed(b, await played([agentStep({ finish: null })]))
    const before = JSON.stringify(b.items)
    expect(b.apply({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toEqual([])
    expect(JSON.stringify(b.items)).toBe(before)
  })

  test('task_updated закрывает карточку, но не воскрешает закрытую', async () => {
    const b = new RibbonBuilder()
    feed(b, await played([agentStep({ finish: null })]))
    const card = only(b.items, 'subagent')[0]!
    const update = (patch: Record<string, unknown>): unknown =>
      b.apply({ type: 'system', subtype: 'task_updated', task_id: card.taskId, patch })
    update({ status: 'running' })
    expect(card.state).toBe('running')
    update({ status: 'failed', error: 'упал' })
    expect(card.state).toBe('failed')
    expect(card.summary).toBe('упал')
    update({ status: 'completed' })
    expect(card.state).toBe('failed')
  })

  test('событие задачи без карточки игнорируется', () => {
    const b = new RibbonBuilder()
    expect(
      b.apply({ type: 'system', subtype: 'task_started', task_id: 'bash1', tool_use_id: 'x', task_type: 'local_bash' })
    ).toEqual([])
    expect(b.apply({ type: 'system', subtype: 'task_progress', task_id: 'bash1', usage: {} })).toEqual([])
    expect(b.items).toEqual([])
  })

  test('parseTaskNotifications читает блок внутри system-reminder', () => {
    const text =
      '<system-reminder><task-notification>\n<task-id>a1</task-id>\n<tool-use-id>tu1</tool-use-id>\n' +
      '<status>failed</status>\n<summary>упал</summary>\n' +
      '<usage><subagent_tokens>10</subagent_tokens><tool_uses>2</tool_uses><duration_ms>30</duration_ms></usage>\n' +
      '</task-notification></system-reminder>\n<task-notification><status>completed</status></task-notification>'
    expect(parseTaskNotifications(text)).toEqual([
      {
        taskId: 'a1',
        toolUseId: 'tu1',
        status: 'failed',
        summary: 'упал',
        usage: { tokens: 10, toolCalls: 2, durationMs: 30 }
      }
    ])
  })

  test('повторное уведомление того же агента перезаписывает статус', async () => {
    const b = new RibbonBuilder()
    const all = await playedToEnd([agentStep({ finish: FINISH })])
    feed(b, all)
    const note = all.find(isNoticeMessage) as { message: { content: string } }
    b.apply({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: note.message.content.replace('completed', 'failed') }
    })
    expect(only(b.items, 'subagent')[0]!.state).toBe('failed')
  })

  test('уведомление в system-reminder закрывает карточку, а текст человека остаётся', async () => {
    const b = new RibbonBuilder()
    const all = await playedToEnd([agentStep({ finish: FINISH })])
    const note = all.find(isNoticeMessage) as { message: { content: string } }
    // everything but the notice, so the card is still running
    feed(b, all.filter((m) => (m as Record<string, unknown>)['subtype'] !== 'task_notification' && !isNoticeMessage(m)))
    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('running')
    b.apply(userMessage(`посмотри ещё\n<system-reminder>${note.message.content}</system-reminder>`))
    expect(card.state).toBe('done')
    expect(bubbles(b)).toEqual(['посмотри ещё'])
  })
})

