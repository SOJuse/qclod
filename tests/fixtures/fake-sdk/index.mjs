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
 * @typedef {{kind:'tool', name:string, input?:object, result?:string, output?:object, pauseMs?:number}} ToolStep
 * @typedef {{kind:'toolRunning', name:string, input?:object}} ToolRunningStep
 * @typedef {{kind:'toolError', name:string, input?:object, error:string, output?:object}} ToolErrorStep
 * @typedef {{kind:'askPermission', name:string, input?:object}} AskPermissionStep
 * @typedef {{kind:'askPermissions', tools:Array<{name:string, input?:object}>}} AskPermissionsStep
 * @typedef {{kind:'askQuestion', question?:string, header?:string, options?:string[], questions?:Array<{question:string, header?:string, options:string[], multiSelect?:boolean}>, echoAnswers?:boolean}} AskQuestionStep
 * @typedef {{kind:'todo', items:Array<{content:string,status:string,activeForm?:string}>}} TodoStep
 * @typedef {{kind:'subagent', name:string, agentType?:string, stats?:{totalTokens?:number, totalDurationMs?:number, totalToolUseCount?:number}, report?:string, steps:Array<object>}} SubagentStep
 * @typedef {{kind:'backgroundAgent', name:string, agentType?:string, agentId?:string, pauseMs?:number,
 *   progress?:Array<{tokens:number, toolUses:number, durationMs:number, lastTool?:string}>,
 *   finish?:{status:'completed'|'failed'|'stopped', summary:string, tokens:number, toolUses:number, durationMs:number}|null}} BackgroundAgentStep
 * @typedef {{kind:'backgroundBash', command:string, description?:string, taskId?:string, chunks?:string[], pauseMs?:number,
 *   finish?:'completed'|'failed'|null}} BackgroundBashStep
 * @typedef {{kind:'compact', preTokens:number, postTokens:number, trigger?:'auto'|'manual'}} CompactStep
 * @typedef {{kind:'crash', message:string}} CrashStep
 * @typedef {{kind:'reportInput'}} ReportInputStep
 * @typedef {{kind:'remoteAnswer', name:string, input?:object, decision:'allow'|'deny', afterMs?:number}} RemoteAnswerStep
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

/** A subagent's id as the CLI writes it: `a` and 16 hex digits. */
function agentHexId() {
  return `a${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function pause(ms) {
  return ms ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

export function createFakeSdk(script = {}) {
  const steps = script.steps ?? []
  const sessionId = script.sessionId ?? randomUUID()
  const canUseTool = script.canUseTool ?? (async () => ({ behavior: 'allow' }))

  // One pair of windows for the whole session, so rate_limit_event and
  // planLimits() tell the same story.
  const now = Math.floor(Date.now() / 1000)
  const windows = {
    fiveHour: script.rateLimits?.fiveHour ?? { utilization: 0.13, resetsAt: now + 3600 },
    sevenDay: script.rateLimits?.sevenDay ?? { utilization: 0.38, resetsAt: now + 400000 }
  }

  /**
   * What background agents still have to say once the turn that launched
   * them has ended — their progress and their notification. Ruling C2: the
   * fake holds it until after that turn's result, so a test can see the turn
   * end while the agent is still running.
   */
  const afterTurn = []

  /**
   * Background shells by task id: what each has written so far, and whether
   * it is over. taskOutput() reads it the way get_task_output reads the
   * task's output file.
   */
  const shells = new Map()

  /** REPLACE semantics: every shell still running, as sdk.d.ts describes it. */
  function backgroundTasksChanged() {
    return {
      type: 'system',
      subtype: 'background_tasks_changed',
      uuid: randomUUID(),
      session_id: sessionId,
      tasks: [...shells]
        .filter(([, shell]) => !shell.stopped)
        .map(([taskId, shell]) => ({ task_id: taskId, task_type: 'local_bash', description: shell.description }))
    }
  }

  /**
   * Messages that do not wait for a turn: what stopTask() makes the CLI say.
   * The stream hands them out as soon as they are here, even while it is
   * waiting for the next send or for a background shell's next piece.
   */
  const outOfBand = []
  let outOfBandWake = null
  function pushOutOfBand(message) {
    outOfBand.push(message)
    if (outOfBandWake) {
      const resume = outOfBandWake
      outOfBandWake = null
      resume()
    }
  }

  /** Sends (and phone turns) waiting to be played as their own turn. */
  const inbox = []
  /** What the CLI says by itself between turns: the bridge, a turn typed on the phone. */
  const outbox = []
  /** Remote Control calls, as the tests read them. */
  const remoteCalls = []
  const remote = script.remoteControl ?? {}
  /** How many sent messages have been answered; the next one plays `turns[answered]`. */
  let answered = 0
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
    contextPercent: script.contextPercent ?? 21,
    /** Turns that have ended with a result; contextPercentByTurn is read by it. */
    turnsDone: 0
  }

  /** How full the context is now: before any turn, then after each one. */
  function contextPercentNow() {
    const byTurn = script.contextPercentByTurn
    if (!byTurn || byTurn.length === 0 || state.turnsDone === 0) return state.contextPercent
    return byTurn[Math.min(state.turnsDone, byTurn.length) - 1]
  }

  /** Questions put to canUseTool that have not been answered yet. */
  const openAsks = new Set()

  /**
   * Asks canUseTool the way the real SDK does: with the id of the tool call
   * the question is about and a signal that fires when the turn is
   * interrupted. An aborted question stops holding the turn open and counts
   * as a refusal — nothing runs on an answer nobody is waiting for.
   */
  async function ask(name, input, toolUseID, abortAfterMs) {
    const controller = new AbortController()
    openAsks.add(controller)
    // A question answered on the phone: the CLI cancels it, the SDK aborts
    // this signal, and a late answer from Qclod is of no interest.
    const timer =
      abortAfterMs === undefined ? null : setTimeout(() => controller.abort(), abortAfterMs)
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
      if (timer) clearTimeout(timer)
      openAsks.delete(controller)
    }
  }

  function toolResult(id, content, isError = false, output = undefined) {
    return {
      type: 'user',
      uuid: randomUUID(),
      session_id: sessionId,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }
        ]
      },
      ...(output !== undefined ? { tool_use_result: output } : {})
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

        case 'thinking': {
          const text = step.text ?? 'размышляю'
          if (!step.ms) {
            yield assistant([{ type: 'thinking', thinking: text }])
            break
          }
          // Timed: streamed like a real session, the block held open `ms`.
          const messageId = `msg_${randomUUID()}`
          const event = (e) => ({ type: 'stream_event', uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, event: e })
          yield event({ type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } })
          yield event({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } })
          await pause(step.ms)
          yield event({ type: 'content_block_stop', index: 0 })
          yield {
            type: 'assistant',
            uuid: randomUUID(),
            session_id: sessionId,
            parent_tool_use_id: null,
            message: { id: messageId, role: 'assistant', content: [{ type: 'thinking', thinking: text }] }
          }
          break
        }

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
          if (step.pauseMs) await pause(step.pauseMs)
          yield toolResult(id, step.result ?? 'ok', false, step.output)
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
          yield toolResult(id, step.error, true, step.output)
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

        // Answered on the phone: Qclod's question is cancelled after afterMs
        // (control_cancel_request, so the signal aborts), and the turn goes
        // on by the decision made there.
        case 'remoteAnswer': {
          const id = randomUUID()
          const input = step.input ?? {}
          state.permissionRequests.push({ name: step.name, input })
          await ask(step.name, input, id, step.afterMs ?? 50)
          if (step.decision === 'allow') {
            yield* play([{ kind: 'tool', id, name: step.name, input, result: 'ok' }])
          } else {
            yield permissionDenied(step.name, { message: 'отклонено с телефона' })
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
          // `questions` is the full form; `question`/`options` stay as the
          // shorthand for a single question.
          const asked = step.questions ?? [
            { question: step.question, header: step.header, options: step.options }
          ]
          const input = {
            questions: asked.map((q) => ({
              question: q.question,
              header: q.header ?? 'Вопрос',
              options: q.options.map((label) => ({ label, description: '' })),
              multiSelect: q.multiSelect === true
            }))
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
            // The tool result is not drawn in the ribbon; this makes what the
            // agent received visible to an end-to-end test.
            if (step.echoAnswers) yield* play([{ kind: 'text', text: `Получено: ${said}` }])
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
          const agentId = agentHexId()
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
            // A nested subagent has already marked its own steps with its id.
            yield { ...nested, parent_tool_use_id: nested.parent_tool_use_id || id }
          }
          // What the agent wrote back: the step's own report, line breaks and all.
          const report = step.report ?? 'подагент закончил'
          yield {
            type: 'user',
            uuid: randomUUID(),
            session_id: sessionId,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: id, content: report }]
            },
            // The Agent tool's structured output, AgentOutput in
            // sdk-tools.d.ts: the run totals a card shows.
            tool_use_result: {
              status: 'completed',
              agentId,
              totalTokens: step.stats?.totalTokens ?? 0,
              totalDurationMs: step.stats?.totalDurationMs ?? 0,
              totalToolUseCount: step.stats?.totalToolUseCount ?? 0,
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                server_tool_use: null,
                service_tier: null,
                cache_creation: null
              },
              prompt: step.name,
              content: [{ type: 'text', text: report }]
            }
          }
          break
        }

        // An agent launched with run_in_background: the call returns at once
        // with async_launched and the task is registered; the rest of its
        // life — progress, then the notification — comes after the turn that
        // launched it has ended.
        case 'backgroundAgent': {
          const id = randomUUID()
          const agentId = step.agentId ?? agentHexId()
          const description = step.name
          const subagentType = step.agentType ?? 'general-purpose'
          const outputFile = `C:\\Users\\fake\\AppData\\Local\\Temp\\claude\\tasks\\${agentId}.output`
          let first = true
          const between = async () => {
            if (!first) await pause(step.pauseMs)
            first = false
          }

          await between()
          yield assistant([
            {
              type: 'tool_use',
              id,
              name: 'Agent',
              input: {
                description,
                ...(step.agentType ? { subagent_type: step.agentType } : {}),
                run_in_background: true
              }
            }
          ])
          await between()
          yield {
            ...toolResult(id, [
              {
                type: 'text',
                text:
                  'Async agent launched successfully.\n' +
                  `agentId: ${agentId} (internal ID - do not mention to user.)\n` +
                  'The agent is working in the background. ' +
                  'You will be notified automatically when it completes.'
              }
            ]),
            tool_use_result: {
              isAsync: true,
              status: 'async_launched',
              agentId,
              description,
              prompt: description,
              outputFile,
              canReadOutputFile: true
            }
          }
          await between()
          yield {
            type: 'system',
            subtype: 'task_started',
            uuid: randomUUID(),
            session_id: sessionId,
            task_id: agentId,
            tool_use_id: id,
            description,
            subagent_type: subagentType,
            task_type: 'local_agent',
            is_backgrounded: true,
            prompt: description
          }

          afterTurn.push(async function* () {
            for (const progress of step.progress ?? []) {
              await between()
              yield {
                type: 'system',
                subtype: 'task_progress',
                uuid: randomUUID(),
                session_id: sessionId,
                task_id: agentId,
                tool_use_id: id,
                description,
                subagent_type: subagentType,
                usage: {
                  total_tokens: progress.tokens,
                  tool_uses: progress.toolUses,
                  duration_ms: progress.durationMs
                },
                ...(progress.lastTool ? { last_tool_name: progress.lastTool } : {})
              }
            }
            const finish = step.finish
            // finish: null — the agent never ends, and nothing says it did.
            if (!finish) return
            await between()
            yield {
              type: 'system',
              subtype: 'task_notification',
              uuid: randomUUID(),
              session_id: sessionId,
              task_id: agentId,
              tool_use_id: id,
              status: finish.status,
              summary: finish.summary,
              output_file: outputFile,
              usage: {
                total_tokens: finish.tokens,
                tool_uses: finish.toolUses,
                duration_ms: finish.durationMs
              }
            }
            await between()
            // The same news as the text the main agent reads next.
            yield {
              type: 'user',
              uuid: randomUUID(),
              session_id: sessionId,
              parent_tool_use_id: null,
              origin: { kind: 'task-notification' },
              message: {
                role: 'user',
                content:
                  '<task-notification>\n' +
                  `<task-id>${agentId}</task-id>\n` +
                  `<tool-use-id>${id}</tool-use-id>\n` +
                  `<output-file>${outputFile}</output-file>\n` +
                  `<status>${finish.status}</status>\n` +
                  `<summary>${finish.summary}</summary>\n` +
                  `<usage><subagent_tokens>${finish.tokens}</subagent_tokens>` +
                  `<tool_uses>${finish.toolUses}</tool_uses>` +
                  `<duration_ms>${finish.durationMs}</duration_ms></usage>\n` +
                  '</task-notification>'
              }
            }
          })
          break
        }

        // A Bash call with run_in_background. Shapes from sdk.d.ts and
        // sdk-tools.d.ts (BashOutput.backgroundTaskId), not from a live
        // session. The call returns at once; the command's output grows after
        // the turn's result, read through taskOutput(), and its end, if any,
        // is a notification and an emptied background_tasks_changed.
        case 'backgroundBash': {
          const id = randomUUID()
          const taskId = step.taskId ?? `b${randomUUID().replace(/-/g, '').slice(0, 8)}`
          const description = step.description ?? step.command
          const outputFile = `C:\\Users\\fake\\AppData\\Local\\Temp\\claude\\tasks\\${taskId}.output`
          shells.set(taskId, { output: '', stopped: false, description })
          yield assistant([
            {
              type: 'tool_use',
              id,
              name: 'Bash',
              input: {
                command: step.command,
                ...(step.description ? { description: step.description } : {}),
                run_in_background: true
              }
            }
          ])
          state.executedTools.push('Bash')
          yield {
            ...toolResult(id, `Command running in background with ID: ${taskId}`),
            tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId }
          }
          yield {
            type: 'system',
            subtype: 'task_started',
            uuid: randomUUID(),
            session_id: sessionId,
            task_id: taskId,
            tool_use_id: id,
            description,
            task_type: 'local_bash',
            is_backgrounded: true
          }
          yield backgroundTasksChanged()

          afterTurn.push(async function* () {
            const shell = shells.get(taskId)
            for (const chunk of step.chunks ?? []) {
              await pause(step.pauseMs)
              if (shell.stopped) return
              shell.output += chunk
            }
            // finish: null — the command never ends by itself.
            if (!step.finish) return
            await pause(step.pauseMs)
            if (shell.stopped) return
            shell.stopped = true
            yield {
              type: 'system',
              subtype: 'task_notification',
              uuid: randomUUID(),
              session_id: sessionId,
              task_id: taskId,
              tool_use_id: id,
              status: step.finish,
              output_file: outputFile,
              summary: `Background command "${description}" ${step.finish}`
            }
            yield backgroundTasksChanged()
          })
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

        // What the last send carried, as the agent would count it: the
        // images that arrived as content, their types and decoded size.
        case 'reportInput': {
          const last = state.sent[state.sent.length - 1]
          const images = (last?.attachments ?? []).filter((a) => a.kind === 'image')
          const types = [...new Set(images.map((a) => a.mediaType))].join(', ')
          const bytes = images.reduce((sum, a) => sum + Buffer.from(a.dataBase64, 'base64').length, 0)
          yield assistant([
            { type: 'text', text: `картинок: ${images.length}; типы: ${types}; байт: ${bytes}` }
          ])
          break
        }

        default:
          throw new Error(`unknown step kind: ${step.kind}`)
      }
    }
  }

  let introduced = false

  /**
   * What the CLI says at the start of its first turn — and not a moment
   * before: CLI 2.1.317 is silent until the first message arrives.
   */
  function* introduce() {
    if (introduced) return
    introduced = true
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
    yield rateLimitEvent(sessionId, windows.fiveHour, windows.sevenDay)
  }

  /** Background agents' late news, in the order they were launched. */
  async function* drainAfterTurn() {
    while (afterTurn.length > 0 && !closed) {
      const tail = afterTurn.shift()
      for await (const message of tail()) {
        if (closed) return
        yield message
      }
    }
  }

  async function* stream() {
    // Non-empty steps are a turn sent before the stream opened. An empty
    // script waits for the first message and says nothing until then.
    if (steps.length > 0) {
      yield* introduce()
      yield* play(steps)
      yield* finishTurn()
      yield* drainAfterTurn()
    }

    // A real session does not end after its answer: it waits for the next
    // message. Without this the app could never be driven past turn one.
    while (!closed) {
      if (outbox.length > 0) {
        yield outbox.shift()
        continue
      }
      if (inbox.length === 0) {
        await new Promise((resolve) => {
          wake = resolve
        })
      }
      if (closed) break
      if (outbox.length > 0) continue
      const input = inbox.shift()
      if (!input) continue

      yield* introduce()
      // The CLI echoes the message back before answering it.
      yield {
        type: 'user',
        uuid: randomUUID(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content: input.text }
      }
      // A phone turn brings its own steps; Qclod's sends play the script's
      // turns in order.
      let turn
      if (input.phone) {
        turn = input.steps ?? script.nextTurn ?? []
      } else {
        turn = script.turns?.[answered] ?? script.nextTurn ?? []
        answered += 1
      }
      yield* play(turn)
      yield* finishTurn()
      yield* drainAfterTurn()
    }
  }

  async function* finishTurnImpl() {
    // Counted before the result goes out: the app asks for the context the
    // moment it sees the result.
    state.turnsDone += 1
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

  /** The turn stream with the out-of-band messages let in between its own. */
  async function* withOutOfBand(inner) {
    let next = null
    try {
      for (;;) {
        if (outOfBand.length > 0) {
          yield outOfBand.shift()
          continue
        }
        next ??= inner.next()
        const arrived = new Promise((resolve) => {
          outOfBandWake = resolve
        })
        const got = await Promise.race([next, arrived.then(() => null)])
        outOfBandWake = null
        if (got === null) continue
        next = null
        if (got.done) return
        yield got.value
      }
    } finally {
      // A read still pending inside is orphaned: whatever it ends with is
      // dropped, never left as an unhandled rejection. return() is not
      // awaited — it queues behind that read.
      next?.catch(() => undefined)
      inner.return?.().catch(() => undefined)
    }
  }

  function wakeStream() {
    if (wake) {
      const resume = wake
      wake = null
      resume()
    }
  }

  function bridgeMessage(item) {
    return {
      type: 'system',
      subtype: 'bridge_state',
      state: item.state,
      detail: item.detail ?? null,
      ...(item.state === 'failed' ? { failure_kind: item.failure_kind ?? 'terminal' } : {}),
      bridge_epoch: 1,
      uuid: randomUUID(),
      session_id: sessionId
    }
  }

  function typeOnPhone(text, phoneSteps) {
    inbox.push({ phone: true, text, steps: phoneSteps })
    wakeStream()
  }

  /** The bridge's states, then the turns typed on the phone, each after its pause. */
  async function runRemoteScript() {
    for (const item of remote.bridge ?? [{ state: 'connected' }]) {
      await pause(item.afterMs)
      if (closed) return
      outbox.push(bridgeMessage(item))
      wakeStream()
    }
    for (const turn of remote.phoneTurns ?? []) {
      await pause(turn.afterMs)
      if (closed) return
      typeOnPhone(turn.text, turn.steps)
    }
  }

  return {
    messages: withOutOfBand(stream()),
    send(input) {
      state.sent.push(input)
      inbox.push(input)
      wakeStream()
    },
    async remoteAvailability() {
      return remote.blocked ? { available: false, reason: remote.blocked } : { available: true }
    },
    /** The CLI's answer to enabling, translated as the real driver does. */
    async setRemoteControl(enabled, name) {
      remoteCalls.push(enabled && name !== undefined ? { enabled, name } : { enabled })
      if (!enabled) {
        outbox.push({
          type: 'system',
          subtype: 'worker_shutting_down',
          reason: 'remote_control_disabled',
          uuid: randomUUID(),
          session_id: sessionId
        })
        wakeStream()
        return null
      }
      if (remote.enableError) throw new Error(remote.enableError)
      void runRemoteScript()
      return {
        sessionUrl: remote.sessionUrl ?? 'https://claude.ai/code/session_fake0001',
        connectUrl: 'https://claude.ai/code?environment=env_fake'
      }
    },
    /** Only the fake: a turn typed on the phone. */
    typeOnPhone,
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
    /** What the plan's usage endpoint would say; Task 2e reads it. */
    async planLimits() {
      if (script.planLimits !== undefined) return script.planLimits
      return { fiveHour: { ...windows.fiveHour }, sevenDay: { ...windows.sevenDay } }
    },
    async getContextUsage() {
      await pause(script.contextUsageDelayMs)
      return {
        model: state.model,
        totalTokens: Math.round((contextPercentNow() / 100) * 200000),
        maxTokens: 200000,
        percentage: contextPercentNow(),
        categories: [
          { name: 'messages', tokens: 30000, kind: 'used' },
          { name: 'system_prompt', tokens: 12000, kind: 'used' },
          { name: 'Autocompact buffer', tokens: 9000, kind: 'buffer' },
          { name: 'Free space', tokens: 149000, kind: 'free' },
          { name: 'MCP tools (deferred)', tokens: 700, kind: 'deferred' }
        ]
      }
    },
    /**
     * The driver's names, not the SDK's (ruling C12): createDriver loads this
     * fixture as the driver. The tail of what the shell wrote — the last
     * 8 KiB — with its whole size, as get_task_output answers.
     */
    async taskOutput(taskId) {
      if (script.taskOutputUnavailable) return null
      const shell = shells.get(taskId)
      if (!shell) return null
      const whole = Buffer.from(shell.output, 'utf8')
      const tail = whole.subarray(Math.max(0, whole.length - 8192))
      return {
        // A cut through a multi-byte letter decodes as U+FFFD, like the CLI's.
        output: tail.toString('utf8'),
        totalBytes: whole.length,
        truncated: whole.length > 8192
      }
    },
    /** Ends a running shell: its notification and the emptied list, outside any turn. */
    async stopTask(taskId) {
      // A CLI that refuses: the task goes on as if nothing was asked.
      if (script.stopTaskError) throw new Error(script.stopTaskError)
      const shell = shells.get(taskId)
      if (!shell || shell.stopped) return
      shell.stopped = true
      pushOutOfBand({
        type: 'system',
        subtype: 'task_notification',
        uuid: randomUUID(),
        session_id: sessionId,
        task_id: taskId,
        status: 'stopped',
        output_file: `C:\\Users\\fake\\AppData\\Local\\Temp\\claude\\tasks\\${taskId}.output`,
        summary: `Background command "${shell.description}" was stopped`
      })
      pushOutOfBand(backgroundTasksChanged())
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
    get remoteCalls() {
      return remoteCalls
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
