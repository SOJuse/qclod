import { beforeEach, describe, expect, test } from 'vitest'
import { BackgroundTracker } from '../../src/main/agent/backgroundTasks'

/** Shapes from sdk.d.ts: SDKTaskStartedMessage, SDKTaskNotificationMessage, … */
function assistantToolUse(id: string, name: string, input: Record<string, unknown>): unknown {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  }
}

function taskStarted(fields: Record<string, unknown>): unknown {
  return { type: 'system', subtype: 'task_started', description: '', ...fields }
}

function notification(taskId: string, status: string): unknown {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    output_file: 'C:/tmp/x.output',
    summary: ''
  }
}

function updated(taskId: string, patch: Record<string, unknown>): unknown {
  return { type: 'system', subtype: 'task_updated', task_id: taskId, patch }
}

function changed(tasks: Array<{ task_id: string; task_type?: string; description?: string }>): unknown {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map((t) => ({ task_type: 'local_bash', description: '', ...t }))
  }
}

let clock = 1000
let t: BackgroundTracker

beforeEach(() => {
  clock = 1000
  t = new BackgroundTracker(() => clock)
})

describe('BackgroundTracker', () => {
  test('task_started local_bash с командой из tool_use', () => {
    expect(t.apply(assistantToolUse('tu1', 'Bash', { command: 'npm run dev', run_in_background: true }))).toBeNull()
    expect(
      t.apply(taskStarted({ task_id: 'b1', tool_use_id: 'tu1', task_type: 'local_bash', description: 'dev', is_backgrounded: true }))
    ).toEqual([
      expect.objectContaining({
        taskId: 'b1',
        toolUseId: 'tu1',
        type: 'local_bash',
        description: 'dev',
        command: 'npm run dev',
        status: 'running',
        startedAt: 1000
      })
    ])
  })

  test('ambient и skip_transcript в список не попадают, даже агенты', () => {
    expect(t.apply(taskStarted({ task_id: 'a1', task_type: 'local_agent', is_backgrounded: true, ambient: true }))).toBeNull()
    expect(t.apply(taskStarted({ task_id: 'm1', task_type: 'monitor', ambient: true }))).toBeNull()
    expect(t.apply(taskStarted({ task_id: 's1', task_type: 'local_bash', skip_transcript: true }))).toBeNull()
    expect(t.tasks).toEqual([])
  })

  test('уведомление stopped ставит итог', () => {
    t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    clock = 5000
    expect(t.apply(notification('b1', 'stopped'))).toEqual([
      expect.objectContaining({ taskId: 'b1', status: 'stopped', endedAt: 5000 })
    ])
    // The same news twice changes nothing.
    expect(t.apply(notification('b1', 'stopped'))).toBeNull()
  })

  test('task_updated killed — остановлена, failed — ошибка', () => {
    t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(taskStarted({ task_id: 'b2', task_type: 'local_bash', is_backgrounded: true }))
    expect(t.apply(updated('b1', { status: 'killed' }))?.find((x) => x.taskId === 'b1')?.status).toBe('stopped')
    expect(t.apply(updated('b2', { status: 'failed' }))?.find((x) => x.taskId === 'b2')?.status).toBe('failed')
    expect(t.apply(updated('b2', { status: 'running' }))).toBeNull()
  })

  test('пропала из background_tasks_changed — completed', () => {
    t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(taskStarted({ task_id: 'b2', task_type: 'local_bash', is_backgrounded: true }))
    expect(t.apply(changed([{ task_id: 'b1' }, { task_id: 'b2' }]))).toBeNull()
    clock = 9000
    const list = t.apply(changed([{ task_id: 'b2' }]))
    expect(list?.find((x) => x.taskId === 'b1')).toMatchObject({ status: 'completed', endedAt: 9000 })
    expect(list?.find((x) => x.taskId === 'b2')).toMatchObject({ status: 'running' })
    // A later notification tells the real outcome.
    expect(t.apply(notification('b1', 'failed'))?.find((x) => x.taskId === 'b1')?.status).toBe('failed')
  })

  test('ошибочно «законченная» по списку снова работает, если task_updated так говорит', () => {
    t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(changed([]))
    const list = t.apply(updated('b1', { status: 'running' }))
    expect(list?.[0]?.status).toBe('running')
    expect(list?.[0]?.endedAt).toBeUndefined()
  })

  test('«законченная» по устаревшему списку снова работает, когда список её называет', () => {
    t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(changed([]))
    expect(t.tasks[0]?.status).toBe('completed')
    const list = t.apply(changed([{ task_id: 'b1' }]))
    expect(list?.[0]).toMatchObject({ taskId: 'b1', status: 'running' })
    expect(list?.[0]?.endedAt).toBeUndefined()
    // A real end is never healed by a list.
    t.apply(notification('b1', 'stopped'))
    expect(t.apply(changed([{ task_id: 'b1' }]))).toBeNull()
  })

  test('возобновлённая задача с тем же id снова работает и встаёт первой', () => {
    t.apply(assistantToolUse('tu1', 'Bash', { command: 'npm run dev' }))
    t.apply(taskStarted({ task_id: 'b1', tool_use_id: 'tu1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(taskStarted({ task_id: 'b2', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(notification('b1', 'stopped'))
    clock = 7000
    const list = t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    expect(list?.map((x) => x.taskId)).toEqual(['b1', 'b2'])
    expect(list?.[0]).toMatchObject({ status: 'running', startedAt: 7000, command: 'npm run dev' })
    expect(list?.[0]?.endedAt).toBeUndefined()
    // A second task_started for a running task changes nothing.
    expect(t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))).toBeNull()
  })

  test('endAll: работающие прерваны с временем конца, законченные не тронуты', () => {
    t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(taskStarted({ task_id: 'b2', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(notification('b1', 'completed'))
    clock = 8000
    const list = t.endAll('interrupted')
    expect(list?.find((x) => x.taskId === 'b2')).toMatchObject({ status: 'interrupted', endedAt: 8000 })
    expect(list?.find((x) => x.taskId === 'b1')?.status).toBe('completed')
    expect(t.endAll('interrupted')).toBeNull()
  })

  test('передний план помнится не бесконечно', () => {
    for (let i = 0; i < 60; i++) {
      t.apply(taskStarted({ task_id: `f${i}`, task_type: 'local_bash', is_backgrounded: false }))
    }
    // The oldest were forgotten: moving one to the background lists nothing.
    expect(t.apply(updated('f0', { is_backgrounded: true }))).toBeNull()
    expect(t.apply(updated('f59', { is_backgrounded: true }))?.[0]?.taskId).toBe('f59')
  })

  test('уже законченную задачу пустой список не трогает', () => {
    t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(notification('b1', 'stopped'))
    expect(t.apply(changed([]))).toBeNull()
    expect(t.tasks[0]?.status).toBe('stopped')
  })

  test('C15: Bash на переднем плане не считается, пока его не увели в фон', () => {
    t.apply(assistantToolUse('tu9', 'Bash', { command: 'npm test' }))
    expect(
      t.apply(taskStarted({ task_id: 'f1', tool_use_id: 'tu9', task_type: 'local_bash', is_backgrounded: false }))
    ).toBeNull()
    expect(t.tasks).toEqual([])
    // Moved to the background: from now on it is listed, with its command.
    clock = 2000
    expect(t.apply(updated('f1', { is_backgrounded: true }))).toEqual([
      expect.objectContaining({ taskId: 'f1', command: 'npm test', status: 'running' })
    ])
  })

  test('C15: законченный на переднем плане так и не появляется', () => {
    t.apply(taskStarted({ task_id: 'f1', task_type: 'local_bash', is_backgrounded: false }))
    expect(t.apply(notification('f1', 'completed'))).toBeNull()
    expect(t.apply(updated('f1', { is_backgrounded: true }))).toBeNull()
    expect(t.tasks).toEqual([])
  })

  test('новые первыми; законченных не больше, чем до 20 в списке', () => {
    for (let i = 0; i < 25; i++) {
      t.apply(taskStarted({ task_id: `b${i}`, task_type: 'local_bash', is_backgrounded: true }))
      t.apply(notification(`b${i}`, 'completed'))
    }
    expect(t.tasks).toHaveLength(20)
    expect(t.tasks[0]?.taskId).toBe('b24')
    expect(t.tasks[19]?.taskId).toBe('b5')
  })

  test('21 работающая задача: ни одна не вытолкнута; выталкиваются только законченные', () => {
    t.apply(taskStarted({ task_id: 'old', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(notification('old', 'completed'))
    for (let i = 0; i < 21; i++) {
      t.apply(taskStarted({ task_id: `a${i}`, task_type: 'local_agent', is_backgrounded: true }))
    }
    expect(t.tasks).toHaveLength(21)
    expect(t.tasks.every((x) => x.status === 'running')).toBe(true)
    expect(t.tasks.map((x) => x.taskId)).toContain('a0')
    // The first to run still gets its end.
    expect(t.apply(notification('a0', 'completed'))?.find((x) => x.taskId === 'a0')).toMatchObject({ status: 'completed' })
    // A new one pushes out the finished, never a running one.
    t.apply(taskStarted({ task_id: 'a21', task_type: 'local_agent', is_backgrounded: true }))
    expect(t.tasks.map((x) => x.taskId)).not.toContain('a0')
    expect(t.tasks.filter((x) => x.status === 'running')).toHaveLength(21)
  })

  test('отданный список не меняется задним числом', () => {
    const first = t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(notification('b1', 'completed'))
    expect(first?.[0]?.status).toBe('running')
  })

  test('чужое и мусор — null', () => {
    expect(t.apply(null)).toBeNull()
    expect(t.apply({ type: 'result' })).toBeNull()
    expect(t.apply(notification('нет-такой', 'completed'))).toBeNull()
  })
})

function progress(taskId: string, fields: Record<string, unknown>): unknown {
  return { type: 'system', subtype: 'task_progress', task_id: taskId, description: 'Running x', ...fields }
}

describe('BackgroundTracker: фоновые агенты (этап 4)', () => {
  const agent = (fields: Record<string, unknown> = {}): unknown =>
    taskStarted({
      task_id: 'ag1',
      tool_use_id: 'toolu_agent',
      task_type: 'local_agent',
      subagent_type: 'Explore',
      description: 'Обзор',
      is_backgrounded: true,
      ...fields
    })

  test('фоновый агент в списке с kind agent и subagentType', () => {
    expect(t.apply(agent())).toEqual([
      expect.objectContaining({
        taskId: 'ag1',
        toolUseId: 'toolu_agent',
        kind: 'agent',
        subagentType: 'Explore',
        type: 'local_agent',
        description: 'Обзор',
        status: 'running'
      })
    ])
  })

  test('оболочка — kind command и без subagentType', () => {
    const [task] = t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))!
    expect(task).toMatchObject({ kind: 'command' })
    expect(task).not.toHaveProperty('subagentType')
  })

  test('агент на переднем плане не в списке, пока не ушёл в фон', () => {
    expect(t.apply(agent({ is_backgrounded: false }))).toBeNull()
    expect(t.tasks).toEqual([])
    const list = t.apply(updated('ag1', { is_backgrounded: true }))
    expect(list).toEqual([expect.objectContaining({ taskId: 'ag1', kind: 'agent', subagentType: 'Explore' })])
  })

  test('агент на переднем плане закончил там же — в список не попадал', () => {
    t.apply(agent({ is_backgrounded: false }))
    expect(t.apply(updated('ag1', { status: 'completed' }))).toBeNull()
    expect(t.apply(notification('ag1', 'completed'))).toBeNull()
    expect(t.tasks).toEqual([])
  })

  test('summary из task_progress; тот же текст список не меняет', () => {
    t.apply(agent())
    expect(t.apply(progress('ag1', { last_tool_name: 'Read' }))).toBeNull()
    expect(t.apply(progress('ag1', { summary: 'Читает модуль вставки' }))).toEqual([
      expect.objectContaining({ taskId: 'ag1', summary: 'Читает модуль вставки' })
    ])
    expect(t.apply(progress('ag1', { summary: 'Читает модуль вставки' }))).toBeNull()
    expect(t.apply(progress('ag1', { summary: 'Правит тест' }))![0]!.summary).toBe('Правит тест')
    expect(t.apply(progress('nobody', { summary: 'x' }))).toBeNull()
  })

  test('summary, пришедший на переднем плане, остаётся при уходе в фон', () => {
    t.apply(agent({ is_backgrounded: false }))
    expect(t.apply(progress('ag1', { summary: 'Ищет' }))).toBeNull()
    expect(t.apply(updated('ag1', { is_backgrounded: true }))![0]).toMatchObject({ summary: 'Ищет' })
  })

  test('возобновлённый агент — та же строка снова работает', () => {
    t.apply(agent())
    clock = 2000
    t.apply(notification('ag1', 'completed'))
    expect(t.tasks[0]).toMatchObject({ status: 'completed', endedAt: 2000 })
    clock = 3000
    // SendMessage: the same task_id, a new run, the SendMessage call's tool_use_id.
    const list = t.apply(agent({ tool_use_id: 'toolu_send', run_id: 'r2' }))!
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ taskId: 'ag1', status: 'running', kind: 'agent' })
    expect(list[0]).not.toHaveProperty('endedAt')
    // The row is the agent, as its ribbon card is: it keeps the Agent call, not the SendMessage that woke it.
    expect(list[0]!.toolUseId).toBe('toolu_agent')
  })

  test('агент и оболочка живут в одном списке', () => {
    t.apply(taskStarted({ task_id: 'b1', task_type: 'local_bash', is_backgrounded: true }))
    t.apply(agent())
    expect(t.tasks.map((x) => [x.taskId, x.kind])).toEqual([
      ['ag1', 'agent'],
      ['b1', 'command']
    ])
    // Gone from background_tasks_changed: the agent ended, the shell stays.
    t.apply(changed([{ task_id: 'b1' }]))
    expect(t.tasks.map((x) => [x.taskId, x.status])).toEqual([
      ['ag1', 'completed'],
      ['b1', 'running']
    ])
  })
})
