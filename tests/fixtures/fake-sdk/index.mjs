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
 * @typedef {{kind:'textStream', pieces:string[], pauseMs?:number}} TextStreamStep
 * @typedef {{kind:'thinking', text?:string, ms?:number}} ThinkingStep
 * @typedef {{kind:'tool', name:string, input?:object, result?:string}} ToolStep
 * @typedef {{kind:'toolRunning', name:string, input?:object}} ToolRunningStep
 * @typedef {{kind:'toolError', name:string, input?:object, error:string}} ToolErrorStep
 * @typedef {{kind:'askPermission', name:string, input?:object}} AskPermissionStep
 * @typedef {{kind:'askPermissions', tools:Array<{name:string, input?:object}>}} AskPermissionsStep
 * @typedef {{kind:'askQuestion', question:string, header?:string, options:string[]}} AskQuestionStep
 * @typedef {{kind:'todo', items:Array<{content:string,status:string}>}} TodoStep
 * @typedef {{kind:'subagent', name:string, agentType?:string, stats?:object, steps:Array<object>}} SubagentStep
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

  /** Sends waiting to be played as their own turn. */
  const inbox = []
  let wake = null
  let closed = false

  const state = {
    sent: [],
    permissionRequests: [],
    questionAnswers: [],
    executedTools: [],
    permissionMode: script.init?.permissionMode ?? 'default',
    model: script.init?.model ?? 'claude-opus-5',
    effort: null,
    interrupted: false,
    disposed: false,
    contextPercent: script.contextPercent ?? 21
  }

  /** Questions put to canUseTool that have not been answered yet. */
  const openAsks = new Set()

  /**
   * Asks canUseTool the way the real SDK does: with the id of the tool call
   * the question is about and a signal that fires when the turn is
   * interrupted. An aborted question stops holding the turn open and counts
   * as a refusal — nothing runs on an answer nobody is waiting for.
   */
  async function ask(name, input, toolUseID) {
    const controller = new AbortController()
    openAsks.add(controller)
    const aborted = new Promise((resolve) => {
      controller.signal.addEventListener(
        'abort',
        () => resolve({ behavior: 'deny', message: 'прервано' }),
        { once: true }
      )
    })
    try {
      return await Promise.race([
        canUseTool(name, input, { toolUseID, signal: controller.signal }),
        aborted
      ])
    } finally {
      openAsks.delete(controller)
    }
  }

  function toolResult(id, content, isError = false) {
    return {
      type: 'user',
      uuid: randomUUID(),
      session_id: sessionId,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }
        ]
      }
    }
  }

  function permissionDenied(name, answer) {
    return {
      type: 'permission_denied',
      uuid: randomUUID(),
      session_id: sessionId,
      tool_name: name,
      message: answer.message ?? 'отклонено'
    }
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

        // What a real session looks like with --include-partial-messages: the
        // text arrives as deltas and the complete message follows it.
        case 'textStream': {
          const messageId = `msg_${randomUUID()}`
          yield {
            type: 'stream_event',
            uuid: randomUUID(),
            session_id: sessionId,
            parent_tool_use_id: null,
            event: {
              type: 'message_start',
              message: { id: messageId, role: 'assistant', content: [] }
            }
          }
          for (const piece of step.pieces ?? []) {
            if (step.pauseMs) await new Promise((r) => setTimeout(r, step.pauseMs))
            yield {
              type: 'stream_event',
              uuid: randomUUID(),
              session_id: sessionId,
              parent_tool_use_id: null,
              event: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: piece }
              }
            }
          }
          const whole = (step.pieces ?? []).join('')
          yield {
            type: 'assistant',
            uuid: randomUUID(),
            session_id: sessionId,
            parent_tool_use_id: null,
            message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: whole }] }
          }
          break
        }

        case 'tool': {
          // `id` is internal: askPermission passes the id it already asked with.
          const id = step.id ?? randomUUID()
          yield assistant([{ type: 'tool_use', id, name: step.name, input: step.input ?? {} }])
          state.executedTools.push(step.name)
          yield toolResult(id, step.result ?? 'ok')
          break
        }

        // A tool call with no result: what the stream looks like when the
        // agent dies between asking for a tool and getting its answer.
        case 'toolRunning':
          yield assistant([
            { type: 'tool_use', id: randomUUID(), name: step.name, input: step.input ?? {} }
          ])
          break

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

        // Asks first and shows the call after, unlike the real CLI (which shows
        // the call, then asks) — the ribbon's order is not this fixture's to
        // change yet. The id asked with is the id of the call that follows, so
        // the two can be matched exactly as in a real session.
        case 'askPermission': {
          const id = randomUUID()
          const input = step.input ?? {}
          state.permissionRequests.push({ name: step.name, input })
          const answer = await ask(step.name, input, id)
          if (answer.behavior === 'allow') {
            yield* play([{ kind: 'tool', id, name: step.name, input, result: 'ok' }])
          } else {
            yield permissionDenied(step.name, answer)
          }
          break
        }

        // Several tools in one assistant message: the real SDK asks about all
        // of them at once, each with its own toolUseID, and the answers come
        // back in whatever order the person gives them.
        case 'askPermissions': {
          const calls = (step.tools ?? []).map((tool) => ({
            id: randomUUID(),
            name: tool.name,
            input: tool.input ?? {}
          }))
          for (const call of calls) {
            state.permissionRequests.push({ name: call.name, input: call.input })
          }
          const answers = await Promise.all(calls.map((c) => ask(c.name, c.input, c.id)))
          const allowed = calls.filter((_, i) => answers[i].behavior === 'allow')
          if (allowed.length > 0) {
            yield assistant(
              allowed.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }))
            )
            for (const call of allowed) {
              state.executedTools.push(call.name)
              yield toolResult(call.id, 'ok')
            }
          }
          for (const [i, call] of calls.entries()) {
            if (answers[i].behavior !== 'allow') yield permissionDenied(call.name, answers[i])
          }
          break
        }

        // The real order: the call reaches the stream first, then canUseTool is
        // asked about it with the same id. The answer comes back in
        // updatedInput.answers (AskUserQuestionInput.answers in sdk-tools.d.ts,
        // question text -> answer); a refusal is an errored tool_result.
        case 'askQuestion': {
          const id = randomUUID()
          // Real AskUserQuestionInput shape, from the SDK's own sdk-tools.d.ts:
          // questions[].options are objects with a label, not bare strings.
          const input = {
            questions: [
              {
                question: step.question,
                header: step.header ?? 'Вопрос',
                options: step.options.map((label) => ({ label, description: '' }))
              }
            ]
          }
          yield assistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input }])
          const answer = await ask('AskUserQuestion', input, id)
          if (answer.behavior === 'allow') {
            const given = answer.updatedInput?.answers ?? {}
            state.questionAnswers.push(given)
            // The wording is the fixture's own; what matters is that the
            // answers reach the agent through the tool's result.
            const said = Object.entries(given)
              .map(([question, choice]) => `"${question}"="${choice}"`)
              .join(', ')
            yield toolResult(id, `Ответы пользователя: ${said}`)
          } else {
            yield toolResult(id, answer.message ?? 'отклонено', true)
          }
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
            {
              type: 'tool_use',
              id,
              // The real subagent tool: «Task» does not exist in this SDK.
              name: 'Agent',
              input: {
                description: step.name,
                ...(step.agentType ? { subagent_type: step.agentType } : {})
              }
            }
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
            },
            // The Task tool's structured output: the run totals a card shows.
            ...(step.stats ? { tool_use_result: step.stats } : {})
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
    yield* finishTurn()

    // A real session does not end after its first answer: it waits for the
    // next message. Without this the app could never be driven past turn one.
    while (!closed) {
      if (inbox.length === 0) {
        await new Promise((resolve) => {
          wake = resolve
        })
      }
      if (closed) break
      const input = inbox.shift()
      if (!input) continue

      // The CLI echoes the message back before answering it.
      yield {
        type: 'user',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: input.text }
      }
      yield* play(script.nextTurn ?? [])
      yield* finishTurn()
    }
  }

  async function* finishTurnImpl() {
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

  const finishTurn = finishTurnImpl

  return {
    messages: stream(),
    send(input) {
      state.sent.push(input)
      inbox.push(input)
      if (wake) {
        const resume = wake
        wake = null
        resume()
      }
    },
    async interrupt() {
      state.interrupted = true
      for (const controller of openAsks) controller.abort()
    },
    async setPermissionMode(mode) {
      state.permissionMode = mode
    },
    async supportedCommands() {
      return script.init?.commands ?? DEFAULT_COMMANDS
    },
    async supportedModels() {
      return (
        script.init?.models ?? [
          {
            value: 'claude-opus-5',
            displayName: 'Opus 5',
            description: 'самая способная',
            supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
          },
          {
            value: 'claude-sonnet-5',
            displayName: 'Sonnet 5',
            description: 'быстрее и дешевле',
            supportedEffortLevels: ['low', 'medium', 'high']
          }
        ]
      )
    },
    async setModel(model) {
      state.model = model
    },
    async setEffort(level) {
      state.effort = level
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
      closed = true
      if (wake) {
        const resume = wake
        wake = null
        resume()
      }
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
    get questionAnswers() {
      return state.questionAnswers
    },
    get permissionMode() {
      return state.permissionMode
    },
    get model() {
      return state.model
    },
    get effort() {
      return state.effort
    },
    get interrupted() {
      return state.interrupted
    },
    get disposed() {
      return state.disposed
    }
  }
}
