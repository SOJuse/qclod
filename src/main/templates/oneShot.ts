import type { HarvestErrorReason } from '../../shared/types'
import { AgentNotFoundError } from '../agent/resolveExecutable'
import { classifyStartFailure } from '../agent/startFailure'

/**
 * One question to the owner's own Claude Code and one answer, with nothing
 * else: no tools, one turn, no settings, the session not written to the
 * history (решение 3; checked on CLI 2.1.317 by the probe of задача 2).
 */

/** The SDK's `query()` as a one-shot uses it; the fixture's fakeOneShot has the same shape. */
export type QueryLike = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>

export interface OneShotRequest {
  systemPrompt: string
  prompt: string
  model: string
  executablePath: string
  cwd: string
  timeoutMs: number
  maxBudgetUsd: number
  signal: AbortSignal
}

export type OneShotAnswer =
  | { kind: 'text'; text: string; costUsd: number | null }
  | { kind: 'error'; reason: HarvestErrorReason; detail?: string }

const DETAIL_MAX = 300
const LIMIT_TEXT = /hit your (session |usage |weekly )?limit|usage limit|rate.?limit/i

export function oneShotOptions(req: OneShotRequest, abort: AbortController): Record<string, unknown> {
  return {
    cwd: req.cwd,
    pathToClaudeCodeExecutable: req.executablePath,
    model: req.model,
    systemPrompt: req.systemPrompt,
    tools: [],
    allowedTools: [],
    maxTurns: 1,
    maxBudgetUsd: req.maxBudgetUsd,
    settingSources: [],
    persistSession: false,
    abortController: abort,
    // With no tools there is nothing to ask about; anything that still asks is refused.
    canUseTool: async () => ({ behavior: 'deny', message: 'Инструменты в этом запросе не нужны' })
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failed(detail: string): OneShotAnswer {
  return { kind: 'error', reason: 'failed', detail: detail.slice(0, DETAIL_MAX) }
}

/** What an error result or a thrown error means for the person. */
function fromMessage(message: string, limited: boolean, loggedOut: boolean): OneShotAnswer {
  if (loggedOut || classifyStartFailure(message) === 'not-logged-in' || /authentication_failed/i.test(message)) {
    return { kind: 'error', reason: 'notLoggedIn' }
  }
  if (limited || LIMIT_TEXT.test(message)) return { kind: 'error', reason: 'limit' }
  return failed(message)
}

export async function runOneShot(query: QueryLike, req: OneShotRequest): Promise<OneShotAnswer> {
  const abort = new AbortController()
  let why: 'timeout' | 'cancelled' | null = null
  const stop = (reason: 'timeout' | 'cancelled'): void => {
    why ??= reason
    abort.abort()
  }
  const onOuter = (): void => stop('cancelled')
  if (req.signal.aborted) return { kind: 'error', reason: 'cancelled' }
  req.signal.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(() => stop('timeout'), req.timeoutMs)

  let limited = false
  let loggedOut = false
  let answer: OneShotAnswer | null = null
  try {
    for await (const message of query({ prompt: req.prompt, options: oneShotOptions(req, abort) })) {
      if (why) break
      const type = message['type']
      if (type === 'rate_limit_event') {
        const info = message['rate_limit_info']
        if (isObject(info) && info['status'] === 'rejected') limited = true
      } else if (type === 'assistant') {
        if (message['error'] === 'rate_limit') limited = true
        if (message['error'] === 'authentication_failed') loggedOut = true
      } else if (type === 'result') {
        const cost = typeof message['total_cost_usd'] === 'number' ? message['total_cost_usd'] : null
        const text = typeof message['result'] === 'string' ? message['result'] : ''
        if (message['subtype'] === 'error_max_budget_usd') answer = { kind: 'error', reason: 'failed', detail: 'запрос вышел за бюджет' }
        else if (message['subtype'] === 'success' && message['is_error'] !== true) answer = { kind: 'text', text, costUsd: cost }
        else answer = fromMessage(text || String(message['subtype'] ?? 'ошибка'), limited, loggedOut)
        break
      }
    }
  } catch (err) {
    if (!why && !answer) {
      if (err instanceof AgentNotFoundError) answer = { kind: 'error', reason: 'noAgent' }
      else answer = fromMessage(err instanceof Error ? err.message : String(err), limited, loggedOut)
    }
  } finally {
    clearTimeout(timer)
    req.signal.removeEventListener('abort', onOuter)
  }
  if (why) return { kind: 'error', reason: why }
  return answer ?? failed('Claude Code не ответил')
}
