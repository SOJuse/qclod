import { describe, expect, test } from 'vitest'
import { CHANNELS, INVOKE_CHANNELS, EVENT_CHANNELS, SEND_CHANNELS } from '@shared/channels'

describe('ipc channel contract', () => {
  test('все имена каналов уникальны', () => {
    const names = Object.values(CHANNELS)
    expect(new Set(names).size).toBe(names.length)
  })

  test('CHANNELS заморожен', () => {
    expect(Object.isFrozen(CHANNELS)).toBe(true)
  })

  test('каждый канал отнесён либо к invoke, либо к event', () => {
    const classified = new Set<string>([...INVOKE_CHANNELS, ...EVENT_CHANNELS, ...SEND_CHANNELS])
    for (const name of Object.values(CHANNELS)) expect(classified.has(name)).toBe(true)
    expect(classified.size).toBe(Object.values(CHANNELS).length)
  })

  test('invoke и event каналы не пересекаются', () => {
    const events = new Set<string>(EVENT_CHANNELS)
    for (const name of INVOKE_CHANNELS) expect(events.has(name)).toBe(false)
  })

  test('«отправить сейчас» из очереди — invoke-канал agent:queueSendNow', () => {
    expect(CHANNELS.agentQueueSendNow).toBe('agent:queueSendNow')
    expect(INVOKE_CHANNELS).toContain('agent:queueSendNow')
  })

  test('Remote Control — invoke-канал agent:remote', () => {
    expect(CHANNELS.agentRemote).toBe('agent:remote')
    expect(INVOKE_CHANNELS).toContain('agent:remote')
  })

  test('«Повторить» вкладки — invoke-канал tabs:retry', () => {
    expect(CHANNELS.tabsRetry).toBe('tabs:retry')
    expect(INVOKE_CHANNELS).toContain('tabs:retry')
  })

  test('пути в тексте: проверка и действия — invoke-каналы files:*', () => {
    expect(CHANNELS.filesResolve).toBe('files:resolve')
    expect(CHANNELS.filesOpen).toBe('files:open')
    expect(CHANNELS.filesReveal).toBe('files:reveal')
    expect(CHANNELS.filesOpenInEditor).toBe('files:openInEditor')
    for (const name of ['files:resolve', 'files:open', 'files:reveal', 'files:openInEditor']) {
      expect(INVOKE_CHANNELS).toContain(name)
    }
  })

  test('вход: invoke setup:login и событие setup:loginProgress; setup:terminal больше нет', () => {
    expect(CHANNELS.setupLogin).toBe('setup:login')
    expect(INVOKE_CHANNELS).toContain('setup:login')
    expect(CHANNELS.setupLoginProgress).toBe('setup:loginProgress')
    expect(EVENT_CHANNELS).toContain('setup:loginProgress')
    expect(Object.values(CHANNELS)).not.toContain('setup:terminal')
    expect(INVOKE_CHANNELS).not.toContain('setup:terminal')
  })

  test('обновление: invoke update:get и update:restart, событие update:changed', () => {
    expect(CHANNELS.updateGet).toBe('update:get')
    expect(CHANNELS.updateRestart).toBe('update:restart')
    expect(CHANNELS.updateChanged).toBe('update:changed')
    expect(INVOKE_CHANNELS).toContain('update:get')
    expect(INVOKE_CHANNELS).toContain('update:restart')
    expect(EVENT_CHANNELS).toContain('update:changed')
  })

  test('отчёт об ошибке окна — send-канал renderer:error, не invoke', () => {
    expect(CHANNELS.rendererError).toBe('renderer:error')
    expect(SEND_CHANNELS).toContain('renderer:error')
    expect(INVOKE_CHANNELS).not.toContain('renderer:error')
  })

  test('этап 2: каналы проектов, раскладки и окна-заглушки', () => {
    const invoke = {
      layoutGet: 'layout:get',
      layoutSet: 'layout:set',
      projectHistory: 'projects:history',
      projectOpenSession: 'projects:openSession',
      projectForget: 'projects:forget',
      rendererRetry: 'window:rendererRetry',
      logsOpen: 'logs:open'
    } as const
    for (const [key, value] of Object.entries(invoke)) {
      expect(CHANNELS[key as keyof typeof CHANNELS]).toBe(value)
      expect(INVOKE_CHANNELS).toContain(value)
    }
    expect(CHANNELS.layoutChanged).toBe('layout:changed')
    expect(EVENT_CHANNELS).toContain('layout:changed')
    expect(INVOKE_CHANNELS).not.toContain('layout:changed')
  })

  test('этап 3: autonomy:hold и autonomy:answerNow — invoke-каналы', () => {
    expect(CHANNELS.autonomyHold).toBe('autonomy:hold')
    expect(CHANNELS.autonomyAnswerNow).toBe('autonomy:answerNow')
    expect(INVOKE_CHANNELS).toContain('autonomy:hold')
    expect(INVOKE_CHANNELS).toContain('autonomy:answerNow')
  })

  test('терминальных каналов v1 больше нет', () => {
    // The pty is gone; a channel that outlives its feature is a trap for the
    // next reader.
    const names = Object.values(CHANNELS).join(' ')
    expect(names).not.toContain('session:write')
    expect(names).not.toContain('session:resize')
    expect(names).not.toContain('session:data')
  })
})
