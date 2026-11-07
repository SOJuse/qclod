import { describe, expect, test } from 'vitest'
import { RibbonBuilder } from '../../src/shared/ribbon'
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
          durationMs: 42000,
          usage: { input_tokens: 12000, output_tokens: 3000 },
          toolUseCount: 7
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
        tool_use_result: { usage: { input_tokens: 20000, output_tokens: 9000 } }
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
        tool_use_result: { durationMs: 42000 }
      })
    )

    expect(only(b.items, 'subagent')[0]!.durationMs).toBe(42000)
  })
})
