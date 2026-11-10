import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { RibbonBuilder, parseTaskNotifications } from '../../src/shared/ribbon'
import { VIEW_CLIP } from '../../src/shared/clip'
import { createFakeSdk } from '../fixtures/fake-sdk/index.mjs'
import { readTranscript } from '../../src/main/agent/transcript'
import { resumedSession, writeTranscript } from '../fixtures/transcript.mjs'
import type { RibbonItem } from '../../src/shared/types'

type SubagentCard = Extract<RibbonItem, { kind: 'subagent' }>

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
    // A frozen clock: the call took no time, so the patch carries no duration.
    const b = new RibbonBuilder({ now: () => 1 })
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

  test('размышления считаются от начала сообщения, а не от первого куска текста', () => {
    let clock = 1000
    const b = new RibbonBuilder({ now: () => clock })

    b.apply(messageStart('msg_t2'))
    clock = 3000
    b.apply({
      type: 'stream_event',
      uuid: uuid(),
      session_id: 's1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'думаю' } }
    })
    clock = 6000
    b.apply({ type: 'stream_event', uuid: uuid(), session_id: 's1', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })

    expect(only(b.items, 'thinking')[0]!.durationMs).toBe(5000)
  })

  test('размышления, пришедшие целиком, считаются от предыдущего события', () => {
    let clock = 1000
    const b = new RibbonBuilder({ now: () => clock })

    b.apply({ type: 'system', subtype: 'init', session_id: 's1', uuid: uuid() })
    clock = 9000
    b.apply(assistant([{ type: 'thinking', thinking: 'взвешиваю' }]))

    const thinking = only(b.items, 'thinking')
    expect(thinking[0]!.done).toBe(true)
    expect(thinking[0]!.durationMs).toBe(8000)
  })

  test('в повторе истории размышления без длительности', () => {
    let clock = 1000
    const b = new RibbonBuilder({ now: () => clock, replay: true })

    b.apply({ type: 'system', subtype: 'init', session_id: 's1', uuid: uuid() })
    clock = 9000
    b.apply(assistant([{ type: 'thinking', thinking: 'взвешиваю' }]))

    expect(only(b.items, 'thinking')[0]!.durationMs).toBe(0)
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
    expect(questions[0]!.questions).toEqual([
      {
        question: 'Какой вариант панели?',
        header: 'Панель',
        multiSelect: false,
        options: [
          { label: 'Справа', description: 'как в приложении' },
          { label: 'Снизу', description: 'как в терминале' }
        ]
      }
    ])
    expect(questions[0]!.answers).toBeNull()
  })

  test('AskUserQuestion с тремя вопросами — одна карточка со всеми тремя', () => {
    const b = new RibbonBuilder()
    const ask = (question: string, multiSelect?: boolean): object => ({
      question,
      header: 'Н',
      ...(multiSelect ? { multiSelect } : {}),
      options: [
        { label: 'А', description: 'первый' },
        { label: 'Б', description: 'второй' }
      ]
    })
    b.apply(
      assistant([
        {
          type: 'tool_use',
          id: 'q3',
          name: 'AskUserQuestion',
          input: { questions: [ask('Один?'), ask('Два?', true), ask('Три?')] }
        }
      ])
    )

    const cards = only(b.items, 'question')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.questions).toHaveLength(3)
    expect(cards[0]!.questions.map((q) => q.multiSelect)).toEqual([false, true, false])
    for (const q of cards[0]!.questions) {
      expect(q.options).toEqual([
        { label: 'А', description: 'первый' },
        { label: 'Б', description: 'второй' }
      ])
    }
  })

  test('ответ на вопрос остаётся в самих элементах, а не только в событии', () => {
    const b = new RibbonBuilder()
    b.apply(
      assistant([
        {
          type: 'tool_use',
          id: 'q1',
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Где?', header: 'Панель', options: [{ label: 'Справа' }] }] }
        }
      ])
    )

    const changes = b.answerQuestion('q1', { 'Где?': 'Справа' })

    expect(changes).toEqual([
      { kind: 'update', id: only(b.items, 'question')[0]!.id, patch: { answers: { 'Где?': 'Справа' } } }
    ])
    // A snapshot is built from the items: a reload must not see the card open again.
    expect(b.items.find((i) => i.kind === 'question')).toMatchObject({ answers: { 'Где?': 'Справа' } })
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


describe('RibbonBuilder: сессия, восстановленная из файла', () => {
  const sessionId = '0f0e0d0c-0b0a-4908-8706-050403020100'
  const cwd = 'C:\\Users\\u\\proj'

  async function replayed(): Promise<{ b: RibbonBuilder; closing: ReturnType<RibbonBuilder['finishReplay']> }> {
    const configDir = mkdtempSync(join(tmpdir(), 'qclod-ribbon-'))
    try {
      const session = resumedSession(sessionId, cwd)
      const path = writeTranscript(configDir, cwd, sessionId, session.lines, session.subagents)
      const b = new RibbonBuilder()
      for (const message of await readTranscript(path)) b.apply(message)
      return { b, closing: b.finishReplay() }
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  }

  test('восстановленная сессия: четыре подагента и честные статусы', async () => {
    const { b, closing } = await replayed()
    const agents = only(b.items, 'subagent')
    expect(agents.map((a) => [a.task, a.state])).toEqual([
      ['Обзор вставки', 'done'],
      ['Прогон тестов', 'done'],
      ['Сборка', 'failed'],
      ['Долгий обзор', 'unfinished']
    ])
    const [explore, tests, build, long] = agents as [SubagentCard, SubagentCard, SubagentCard, SubagentCard]
    expect(explore.tokens).toBe(18000)
    expect(explore.summary).toBe('Вставка падает в onPaste: пустой clipboardData.')
    expect(tests.tokens).toBe(93175)
    expect(tests.toolCalls).toBe(18)
    expect(tests.background).toBe(true)
    expect(build.summary).toContain("Agent type 'builder' not found")
    expect(long.summary).toBe('не закончил')
    // finishReplay closed exactly the one still running.
    expect(closing).toEqual([{ kind: 'update', id: long.id, patch: { state: 'unfinished', summary: 'не закончил' } }])

    // Their steps sit inside their cards, not in the main stream.
    const nested = b.items.filter((i) => i.parentId === explore.id)
    expect(nested.map((i) => i.kind)).toEqual(['tool', 'agentText'])
    expect(nested[0]).toMatchObject({ kind: 'tool', name: 'Read', state: 'done' })
    expect(b.items.filter((i) => i.parentId === tests.id).map((i) => i.kind)).toEqual(['tool', 'agentText'])
    // A subagent's prompt is from the main agent, not the person: no bubble.
    // What was typed mid-turn is the person's too, shown once, after the notice.
    expect(bubbles(b)).toEqual(['найди, где падает вставка', 'теперь проверь тесты', 'и ещё глянь логи'])
  })

  test('сводка сжатия — не пузырь, а часть разделителя', async () => {
    const { b } = await replayed()
    expect(bubbles(b).some((t) => t.includes('This session is being continued'))).toBe(false)
    const compaction = only(b.items, 'compaction')
    expect(compaction).toHaveLength(1)
    expect(compaction[0]!.freedTokens).toBe(160000)
    expect(compaction[0]!.summary?.startsWith('This session is being continued from a previous conversation')).toBe(
      true
    )
    // It stands after what came before it and before what came after.
    const at = b.items.indexOf(compaction[0]!)
    expect(b.items.slice(0, at).some((i) => i.kind === 'agentText' && i.text === 'смотрю')).toBe(true)
    expect(b.items.slice(at).some((i) => i.kind === 'user' && i.text === 'теперь проверь тесты')).toBe(true)
  })

  test('сводка сжатия патчит последний разделитель, isMeta пузыря не даёт', () => {
    const b = new RibbonBuilder()
    b.apply({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 10, post_tokens: 4 } })
    const changes = b.apply(userMessage('This session is being continued… сводка', { isCompactSummary: true }))
    const card = only(b.items, 'compaction')[0]!
    expect(changes).toEqual([{ kind: 'update', id: card.id, patch: { summary: 'This session is being continued… сводка' } }])
    expect(card.summary).toBe('This session is being continued… сводка')

    expect(b.apply(userMessage('служебное', { isMeta: true }))).toEqual([])
    expect(b.apply(userMessage('служебное', { is_meta: true }))).toEqual([])
    expect(bubbles(b)).toEqual([])
  })

  test('finishReplay закрывает и инструмент, оставшийся без ответа', () => {
    const b = new RibbonBuilder()
    b.apply(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]))
    const changes = b.finishReplay()
    const tool = only(b.items, 'tool')[0]!
    expect(tool.summary).toBe('не закончил')
    expect(changes).toEqual([{ kind: 'update', id: tool.id, patch: { state: 'done', summary: 'не закончил' } }])
  })
})

describe('RibbonBuilder: карточка хранит вызов целиком', () => {
  function call(id: string, name: string, input: Record<string, unknown>): unknown {
    return assistant([{ type: 'tool_use', id, name, input }])
  }

  test('карточка хранит вход, выход и время вызова', () => {
    let clock = 1000
    const b = new RibbonBuilder({ now: () => clock })
    b.apply(call('t1', 'Bash', { command: 'ls' }))
    expect(only(b.items, 'tool')[0]).toMatchObject({ input: { command: 'ls' }, startedAt: 1000 })
    clock = 2200
    const changes = b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'a' }], {
        tool_use_result: { stdout: 'a', stderr: '', interrupted: false }
      })
    )
    expect(only(b.items, 'tool')[0]).toMatchObject({
      input: { command: 'ls' },
      output: { stdout: 'a' },
      durationMs: 1200
    })
    // The change on the wire carries them too: the renderer only sees patches.
    expect(changes[0]).toMatchObject({ kind: 'update', patch: { output: { stdout: 'a' }, durationMs: 1200 } })
  })

  test('огромный выход режется, originalFile выбрасывается', () => {
    const b = new RibbonBuilder()
    b.apply(call('t1', 'Edit', { file_path: 'a.ts', old_string: 'x'.repeat(100_000), new_string: 'y' }))
    b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], {
        tool_use_result: { filePath: 'a.ts', originalFile: 'z'.repeat(1_000_000), structuredPatch: [] }
      })
    )
    const card = only(b.items, 'tool')[0]!
    expect(JSON.stringify(card.output)).not.toContain('zzzz')
    expect(JSON.stringify(card.input).length).toBeLessThan(21_000 + 200)
  })

  test('результат без структурного выхода: output не появляется, время есть', () => {
    let clock = 10
    const b = new RibbonBuilder({ now: () => clock })
    b.apply(call('t1', 'Read', { file_path: 'a.ts' }))
    clock = 500
    b.apply(toolResult('t1', 'текст'))
    const card = only(b.items, 'tool')[0]!
    expect(card).not.toHaveProperty('output')
    expect(card.durationMs).toBe(490)
  })

  test('ошибка сохраняет вход и время', () => {
    let clock = 1000
    const b = new RibbonBuilder({ now: () => clock })
    b.apply(call('t1', 'Bash', { command: 'false' }))
    clock = 1700
    const changes = b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 1', is_error: true }], {
        tool_use_result: { stdout: '', stderr: 'boom', interrupted: false }
      })
    )
    expect(only(b.items, 'toolError')[0]).toMatchObject({
      input: { command: 'false' },
      startedAt: 1000,
      durationMs: 700,
      output: { stderr: 'boom' },
      error: 'Exit code 1'
    })
    expect(changes[0]).toMatchObject({ kind: 'update', patch: { kind: 'toolError', durationMs: 700 } })
  })

  test('результат в тот же миллисекунд: длительности нет', () => {
    const b = new RibbonBuilder({ now: () => 5 })
    b.apply(call('t1', 'Bash', { command: 'ls' }))
    b.apply(toolResult('t1', 'a'))
    expect(only(b.items, 'tool')[0]).not.toHaveProperty('durationMs')
  })

  test('из JSONL: toolUseResult доезжает до карточки', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qclod-tooloutput-'))
    try {
      const sid = '1f0e0d0c-0b0a-4908-8706-050403020101'
      const line = (extra: Record<string, unknown>, n: number): Record<string, unknown> => ({
        parentUuid: n === 1 ? null : `00000000-0000-4000-8000-00000000000${n - 1}`,
        isSidechain: false,
        uuid: `00000000-0000-4000-8000-00000000000${n}`,
        sessionId: sid,
        ...extra
      })
      const path = writeTranscript(dir, 'C:\\p', sid, [
        line({ type: 'user', message: { role: 'user', content: 'запусти' } }, 1),
        line(
          {
            type: 'assistant',
            message: {
              id: 'm1',
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }]
            }
          },
          2
        ),
        line(
          {
            type: 'user',
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a' }] },
            toolUseResult: { stdout: 'a', stderr: '', interrupted: false }
          },
          3
        )
      ])
      const b = new RibbonBuilder()
      for (const m of await readTranscript(path)) b.apply(m)
      expect(only(b.items, 'tool')[0]).toMatchObject({
        input: { command: 'ls' },
        output: { stdout: 'a', stderr: '', interrupted: false }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('RibbonBuilder: границы того, что хранит карточка', () => {
  const call = (id: string, name: string, input: Record<string, unknown>): unknown =>
    assistant([{ type: 'tool_use', id, name, input }])

  test('мегабайт текста результата режется в detail и в патче', () => {
    const b = new RibbonBuilder()
    b.apply(call('t1', 'Bash', { command: 'big' }))
    const changes = b.apply(toolResult('t1', 'x'.repeat(1_000_000)))
    expect(only(b.items, 'tool')[0]!.detail.length).toBeLessThan(VIEW_CLIP + 60)
    expect(JSON.stringify(changes).length).toBeLessThan(VIEW_CLIP + 1000)
  })

  test('мегабайт текста ошибки режется', () => {
    const b = new RibbonBuilder()
    b.apply(call('t1', 'Bash', { command: 'big' }))
    const changes = b.apply(toolResult('t1', 'e'.repeat(1_000_000), true))
    expect(only(b.items, 'toolError')[0]!.error.length).toBeLessThan(VIEW_CLIP + 60)
    expect(JSON.stringify(changes).length).toBeLessThan(VIEW_CLIP + 1000)
  })

  test('счёт большого файла посчитан до обрезки', () => {
    const b = new RibbonBuilder()
    b.apply(call('t1', 'Write', { file_path: 'big.ts' }))
    const content = Array.from({ length: 20_000 }, (_, i) => `строка ${i}`).join('\n')
    b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], {
        tool_use_result: { type: 'create', filePath: 'big.ts', content, structuredPatch: [] }
      })
    )
    const output = only(b.items, 'tool')[0]!.output as Record<string, unknown>
    expect(String(output['content']).length).toBeLessThan(VIEW_CLIP + 60)
    expect(output['_counts']).toMatchObject({ size: content.length, totalLines: 20_000 })
  })

  test('счёт большого диффа посчитан до обрезки', () => {
    const b = new RibbonBuilder()
    b.apply(call('t1', 'Edit', { file_path: 'a.ts' }))
    const lines = Array.from({ length: 3000 }, (_, i) => (i % 3 === 0 ? `-${'o'.repeat(100)}` : `+${'n'.repeat(100)}`))
    b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], {
        tool_use_result: { filePath: 'a.ts', structuredPatch: [{ oldStart: 1, newStart: 1, lines }] }
      })
    )
    const output = only(b.items, 'tool')[0]!.output as Record<string, unknown>
    expect(output['_counts']).toEqual({ added: 2000, removed: 1000 })
  })

  test('при воспроизведении истории времени нет, вживую — есть', () => {
    let clock = 100
    const b = new RibbonBuilder({ now: () => clock, replay: true })
    b.apply(call('t1', 'Bash', { command: 'ls' }))
    clock = 900
    b.apply(toolResult('t1', 'a'))
    expect(only(b.items, 'tool')[0]).not.toHaveProperty('startedAt')
    expect(only(b.items, 'tool')[0]).not.toHaveProperty('durationMs')
    b.finishReplay()
    b.apply(call('t2', 'Bash', { command: 'ls' }))
    clock = 1500
    b.apply(toolResult('t2', 'a'))
    expect(only(b.items, 'tool')[1]).toMatchObject({ startedAt: 900, durationMs: 600 })
  })
})

describe('RibbonBuilder: отчёт подагента', () => {
  function launched(): RibbonBuilder {
    const b = new RibbonBuilder()
    b.apply(
      assistant([{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'найти', subagent_type: 'Explore' } }])
    )
    return b
  }

  test('отчёт подагента — весь текст из AgentOutput.content, с переводами строк', () => {
    const b = launched()
    const report = 'Нашёл три места:\n1. a.ts\n2. b.ts\n3. c.ts'
    b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 'ag1', content: [{ type: 'text', text: report }] }], {
        tool_use_result: {
          status: 'completed',
          agentId: 'a0123456789abcdef',
          content: [{ type: 'text', text: report }],
          totalTokens: 10,
          totalDurationMs: 10,
          totalToolUseCount: 3
        }
      })
    )
    const item = only(b.items, 'subagent')[0]!
    expect(item.report).toBe('Нашёл три места:\n1. a.ts\n2. b.ts\n3. c.ts')
    // The one-line summary is still short; the report is the whole text.
    expect(item.summary).not.toContain('\n')
  })

  test('несколько текстовых блоков — абзацами', () => {
    const b = launched()
    b.apply(
      userMessage([{ type: 'tool_result', tool_use_id: 'ag1', content: 'x' }], {
        tool_use_result: { content: [{ type: 'text', text: 'первый' }, { type: 'text', text: 'второй' }] }
      })
    )
    expect(only(b.items, 'subagent')[0]!.report).toBe('первый\n\nвторой')
  })

  test('без структуры отчёт — текст tool_result', () => {
    const b = launched()
    b.apply(toolResult('ag1', 'строка 1\nстрока 2'))
    expect(only(b.items, 'subagent')[0]!.report).toBe('строка 1\nстрока 2')
  })

  test('длинный отчёт обрезан до 8000 символов с пометкой', () => {
    const b = launched()
    const long = 'я'.repeat(9000)
    b.apply(toolResult('ag1', long))
    const report = only(b.items, 'subagent')[0]!.report!
    expect(report.startsWith('я'.repeat(8000))).toBe(true)
    expect(report).toContain('обрезано: 1000')
  })

  test('у фонового агента отчёт — summary уведомления', async () => {
    const b = new RibbonBuilder()
    const all = await playedToEnd([agentStep({ finish: { ...FINISH, summary: 'итог:\nвсё зелёное' } })])
    feed(b, all)
    const card = only(b.items, 'subagent')[0]!
    expect(card.state).toBe('done')
    expect(card.report).toBe('итог:\nвсё зелёное')
  })

  test('фейк отдаёт report шага как content и как текст результата', async () => {
    const b = new RibbonBuilder()
    feed(b, await played([{ kind: 'subagent', name: 'обзор', report: 'а\nб', steps: [] }]))
    expect(only(b.items, 'subagent')[0]!.report).toBe('а\nб')
  })
})
