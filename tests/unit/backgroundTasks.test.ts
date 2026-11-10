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

  test('подагенты и ambient в список не попадают', () => {
    expect(t.apply(taskStarted({ task_id: 'a1', task_type: 'local_agent', is_backgrounded: true }))).toBeNull()
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
    // Its end while still in the foreground adds nothing either.
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

  test('новые первыми, не больше 20', () => {
    for (let i = 0; i < 25; i++) {
      t.apply(taskStarted({ task_id: `b${i}`, task_type: 'local_bash', is_backgrounded: true }))
    }
    expect(t.tasks).toHaveLength(20)
    expect(t.tasks[0]?.taskId).toBe('b24')
    expect(t.tasks[19]?.taskId).toBe('b5')
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
