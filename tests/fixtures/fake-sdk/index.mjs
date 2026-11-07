/**
 * Fake Agent SDK driver.
 *
 * Stands in for `@anthropic-ai/claude-agent-sdk` in every automated test, so
 * the suite is deterministic, needs no account and spends no tokens. It speaks
 * the parts of the real message stream Qclod depends on, and every shape here
 * was copied from a live session — see
 * `docs/superpowers/notes/2026-11-07-sdk-probe-results.md`. Shapes are not
 * invented: a fixture that lies is worse than no fixture.
 *
 * Written as .mjs so the same file serves both the unit tests and the packaged
 * app under e2e, without a build step in between.
 *
 * @typedef {{kind:'text', text:string}} TextStep
 * @typedef {{kind:'thinking', text?:string, ms?:number}} ThinkingStep
 * @typedef {{kind:'tool', name:string, input?:object, result?:string}} ToolStep
 * @typedef {{kind:'toolError', name:string, input?:object, error:string}} ToolErrorStep
 * @typedef {{kind:'askPermission', name:string, input?:object}} AskPermissionStep
 * @typedef {{kind:'askQuestion', question:string, header?:string, options:string[]}} AskQuestionStep
 * @typedef {{kind:'todo', items:Array<{content:string,status:string}>}} TodoStep
 * @typedef {{kind:'subagent', name:string, steps:Array<object>}} SubagentStep
 * @typedef {{kind:'compact', preTokens:number, postTokens:number, trigger?:'auto'|'manual'}} CompactStep
 * @typedef {{kind:'crash', message:string}} CrashStep
 */

import { randomUUID } from 'node:crypto'

const DEFAULT_COMMANDS = [
  { name: 'compact', description: 'Сжать контекст', argumentHint: '', builtin: true },
  { name: 'model', description: 'Сменить модель', argumentHint: '<model>', builtin: true },
  { name: 'effort', description: 'Сменить усилие', argumentHint: '<level>', builtin: true },
  { name: 'resume', description: 'Открыть прошлую сессию', argumentHint: '', builtin: true },
  { name: 'clear', description: 'Очистить разговор', argumentHint: '', builtin: true },
  { name: 'my-command', description: 'Команда пользователя', argumentHint: '', builtin: false }
]

/** Shape taken from a live rate_limit_event (probe note 2). */
function rateLimitEvent(sessionId, fiveHour, sevenDay) {
  return {
    type: 'rate_limit_event',
    uuid: randomUUID(),
    session_id: sessionId,
    rate_limit_info: {
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: fiveHour.resetsAt,
      unifiedWindows: { five_hour: fiveHour, seven_day: sevenDay }
    }
  }
}

export function createFakeSdk(script = {}) {
  const steps = script.steps ?? []
  const sessionId = script.sessionId ?? randomUUID()
  const canUseTool = script.canUseTool ?? (async () => ({ behavior: 'allow' }))

  const state = {
    sent: [],
    permissionRequests: [],
    executedTools: [],
    permissionMode: script.init?.permissionMode ?? 'default',
    interrupted: false,
    disposed: false,
    contextPercent: script.contextPercent ?? 21
  }

  function assistant(content) {
    return {
      type: 'assistant',
      uuid: randomUUID(),
      session_id: sessionId,
      message: { role: 'assistant', content }
    }
  }

  async function* play(stepList) {
    for (const step of stepList) {
      switch (step.kind) {
        case 'text':
          yield assistant([{ type: 'text', text: step.text }])
          break

        case 'thinking':
          yield assistant([{ type: 'thinking', thinking: step.text ?? 'размышляю' }])
          break

        case 'tool': {
          const id = randomUUID()
          yield assistant([{ type: 'tool_use', id, name: step.name, input: step.input ?? {} }])
          state.executedTools.push(step.name)
          yield {
            type: 'user',
            uuid: randomUUID(),
            session_id: sessionId,
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: id, content: step.result ?? 'ok' }
              ]
            }
          }
          break
        }

        case 'toolError': {
          const id = randomUUID()
          yield assistant([{ type: 'tool_use', id, name: step.name, input: step.input ?? {} }])
          yield {
            type: 'user',
            uuid: randomUUID(),
            session_id: sessionId,
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: id, content: step.error, is_error: true }
              ]
            }
          }
          break
        }

        case 'askPermission': {
          const input = step.input ?? {}
          state.permissionRequests.push({ name: step.name, input })
          const answer = await canUseTool(step.name, input, { sessionId })
          if (answer.behavior === 'allow') {
            yield* play([{ kind: 'tool', name: step.name, input, result: 'ok' }])
          } else {
            yield {
              type: 'permission_denied',
              uuid: randomUUID(),
              session_id: sessionId,
              tool_name: step.name,
              message: answer.message ?? 'отклонено'
            }
          }
          break
        }

        case 'askQuestion': {
          const id = randomUUID()
          yield assistant([
            {
              type: 'tool_use',
              id,
              name: 'AskUserQuestion',
              // Real AskUserQuestionInput shape, from the SDK's own sdk-tools.d.ts:
              // questions[].options are objects with a label, not bare strings.
              input: {
                questions: [
                  {
                    question: step.question,
                    header: step.header ?? 'Вопрос',
                    options: step.options.map((label) => ({ label, description: '' }))
                  }
                ]
              }
            }
          ])
          break
        }

        case 'todo':
          yield* play([
            { kind: 'tool', name: 'TodoWrite', input: { todos: step.items }, result: 'ok' }
          ])
          break

        case 'subagent': {
          const id = randomUUID()
          yield assistant([
            { type: 'tool_use', id, name: 'Task', input: { description: step.name } }
          ])
          for await (const nested of play(step.steps ?? [])) {
            yield { ...nested, parent_tool_use_id: id }
          }
          yield {
            type: 'user',
            uuid: randomUUID(),
            session_id: sessionId,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: id, content: 'подагент закончил' }]
            }
          }
          break
        }

        case 'compact':
          yield {
            type: 'system',
            subtype: 'compact_boundary',
            uuid: randomUUID(),
            session_id: sessionId,
            compact_metadata: {
              trigger: step.trigger ?? 'auto',
              pre_tokens: step.preTokens,
              post_tokens: step.postTokens,
              duration_ms: 1200
            }
          }
          break

        case 'crash':
          throw new Error(step.message)

        default:
          throw new Error(`unknown step kind: ${step.kind}`)
      }
    }
  }

  async function* stream() {
    const now = Math.floor(Date.now() / 1000)
    yield {
      type: 'system',
      subtype: 'init',
      uuid: randomUUID(),
      session_id: sessionId,
      cwd: script.init?.cwd ?? 'C:/проект',
      model: script.init?.model ?? 'claude-opus-5',
      permissionMode: state.permissionMode,
      mcp_servers: script.init?.mcpServers ?? [],
      slash_commands: script.init?.slashCommands ?? DEFAULT_COMMANDS.map((c) => c.name),
      tools: ['Read', 'Edit', 'Bash'],
      claude_code_version: 'fake'
    }
    yield rateLimitEvent(
      sessionId,
      script.rateLimits?.fiveHour ?? { utilization: 0.13, resetsAt: now + 3600 },
      script.rateLimits?.sevenDay ?? { utilization: 0.38, resetsAt: now + 400000 }
    )

    yield* play(steps)

    yield {
      type: 'result',
      subtype: 'success',
      uuid: randomUUID(),
      session_id: sessionId,
      is_error: false,
      num_turns: 1,
      duration_ms: 1234,
      total_cost_usd: script.costUsd ?? 0.0421,
      usage: {
        input_tokens: 12,
        output_tokens: 240,
        cache_creation_input_tokens: 1400,
        cache_read_input_tokens: 44022
      },
      result: 'done'
    }
  }

  return {
    messages: stream(),
    send(input) {
      state.sent.push(input)
    },
    async interrupt() {
      state.interrupted = true
    },
    async setPermissionMode(mode) {
      state.permissionMode = mode
    },
    async supportedCommands() {
      return script.init?.commands ?? DEFAULT_COMMANDS
    },
    async mcpServerStatus() {
      return script.init?.mcpServers ?? []
    },
    async getContextUsage() {
      return {
        totalTokens: Math.round((state.contextPercent / 100) * 200000),
        maxTokens: 200000,
        percentage: state.contextPercent,
        categories: [
          { name: 'messages', tokens: 30000, kind: 'used' },
          { name: 'system_prompt', tokens: 12000, kind: 'used' }
        ]
      }
    },
    async dispose() {
      state.disposed = true
    },

    get sent() {
      return state.sent
    },
    get permissionRequests() {
      return state.permissionRequests
    },
    get executedTools() {
      return state.executedTools
    },
    get permissionMode() {
      return state.permissionMode
    },
    get interrupted() {
      return state.interrupted
    },
    get disposed() {
      return state.disposed
    }
  }
}
