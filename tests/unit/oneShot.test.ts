import { describe, expect, test } from 'vitest'
import { oneShotOptions, runOneShot, type OneShotRequest, type QueryLike } from '@main/templates/oneShot'
import { AgentNotFoundError } from '@main/agent/resolveExecutable'
import { fakeOneShot } from '../fixtures/fake-sdk/index.mjs'

function request(extra: Partial<OneShotRequest> = {}): OneShotRequest {
  return {
    systemPrompt: 'системный',
    prompt: '<msg>\nпривет\n</msg>',
    model: 'sonnet',
    executablePath: 'C:\\claude.exe',
    cwd: 'C:\\tmp\\harvest',
    timeoutMs: 10_000,
    maxBudgetUsd: 0.5,
    signal: new AbortController().signal,
    ...extra
  }
}

describe('oneShotOptions', () => {
  test('без инструментов, один ход, без настроек и без записи сессии; инструменты запрещены', async () => {
    const abort = new AbortController()
    const options = oneShotOptions(request(), abort)
    const { canUseTool, ...rest } = options as { canUseTool: (...a: unknown[]) => Promise<unknown> } & Record<string, unknown>
    expect(rest).toEqual({
      cwd: 'C:\\tmp\\harvest',
      pathToClaudeCodeExecutable: 'C:\\claude.exe',
      model: 'sonnet',
      systemPrompt: 'системный',
      tools: [],
      allowedTools: [],
      maxTurns: 1,
      maxBudgetUsd: 0.5,
      settingSources: [],
      persistSession: false,
      abortController: abort
    })
    expect(await canUseTool('Read', {}, {})).toEqual({ behavior: 'deny', message: 'Инструменты в этом запросе не нужны' })
  })
})

describe('runOneShot', () => {
  test('ответ — текст result и стоимость', async () => {
    const query = fakeOneShot({ text: '[{"title":"A","body":"b"}]', costUsd: 0.01 })
    expect(await runOneShot(query as QueryLike, request())).toEqual({
      kind: 'text',
      text: '[{"title":"A","body":"b"}]',
      costUsd: 0.01
    })
    expect(query.calls[0]!.prompt).toBe('<msg>\nпривет\n</msg>')
    expect(query.calls[0]!.options['persistSession']).toBe(false)
  })

  test('не вошёл и лимит', async () => {
    expect(await runOneShot(fakeOneShot({ fail: 'notLoggedIn' }) as QueryLike, request())).toMatchObject({
      kind: 'error',
      reason: 'notLoggedIn'
    })
    expect(await runOneShot(fakeOneShot({ fail: 'limit' }) as QueryLike, request())).toMatchObject({
      kind: 'error',
      reason: 'limit'
    })
  })

  test('тайм-аут прерывает запрос', async () => {
    const started = Date.now()
    const answer = await runOneShot(fakeOneShot({ delayMs: 5000 }) as QueryLike, request({ timeoutMs: 50 }))
    expect(answer).toEqual({ kind: 'error', reason: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('внешний сигнал — cancelled', async () => {
    const outer = new AbortController()
    const pending = runOneShot(fakeOneShot({ delayMs: 5000 }) as QueryLike, request({ signal: outer.signal }))
    setTimeout(() => outer.abort(), 20)
    expect(await pending).toEqual({ kind: 'error', reason: 'cancelled' })
  })

  test('нет агента, бюджет и прочие сбои', async () => {
    const throwing = (err: Error): QueryLike => () =>
      (async function* () {
        throw err
      })()
    expect(await runOneShot(throwing(new AgentNotFoundError('claude')), request())).toMatchObject({ reason: 'noAgent' })
    const long = new Error('x'.repeat(1000))
    const failed = await runOneShot(throwing(long), request())
    expect(failed).toMatchObject({ kind: 'error', reason: 'failed' })
    expect((failed as { detail: string }).detail.length).toBeLessThanOrEqual(300)

    const budget: QueryLike = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.5 }
      })()
    expect(await runOneShot(budget, request())).toEqual({ kind: 'error', reason: 'failed', detail: 'запрос вышел за бюджет' })
  })
})
