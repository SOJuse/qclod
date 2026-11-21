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
 * @typedef {{kind:'askPermission', name:string, input?:object, echo?:boolean}} AskPermissionStep
 * @typedef {{kind:'askPermissions', tools:Array<{name:string, input?:object}>}} AskPermissionsStep
 * @typedef {{kind:'askQuestion', question?:string, header?:string, options?:string[], questions?:Array<{question:string, header?:string, options:string[], multiSelect?:boolean}>, echoAnswers?:boolean, echo?:boolean}} AskQuestionStep
 * @typedef {{kind:'plan', plan:string, echo?:boolean}} PlanStep
 * @typedef {{kind:'todo', items:Array<{content:string,status:string,activeForm?:string}>}} TodoStep
 * @typedef {{kind:'subagent', name:string, agentType?:string, agentId?:string, label?:string, prompt?:string, model?:string,
 *   progress?:Array<{summary?:string, tokens:number, toolUses:number, durationMs:number, lastTool?:string}>, holdMs?:number,
 *   stats?:{totalTokens?:number, totalDurationMs?:number, totalToolUseCount?:number}, report?:string, steps:Array<object>}} SubagentStep
 * @typedef {{kind:'backgroundAgent', name:string, agentType?:string, agentId?:string, pauseMs?:number,
 *   progress?:Array<{summary?:string, tokens:number, toolUses:number, durationMs:number, lastTool?:string}>,
 *   finish?:{status:'completed'|'failed'|'stopped', summary:string, tokens:number, toolUses:number, durationMs:number}|null}} BackgroundAgentStep
 * @typedef {{kind:'backgroundBash', command:string, description?:string, taskId?:string, chunks?:string[], pauseMs?:number,
 *   finish?:'completed'|'failed'|null}} BackgroundBashStep
 * @typedef {{kind:'compact', preTokens:number, postTokens:number, trigger?:'auto'|'manual'}} CompactStep
 * @typedef {{kind:'crash', message:string, times?:number, beforeInit?:boolean}} CrashStep
 * @typedef {{kind:'limitHit', type?:'five_hour'|'seven_day', resetsInMs:number, times?:number}} LimitHitStep
 * @typedef {{kind:'reportInput'}} ReportInputStep
 * @typedef {{kind:'remoteAnswer', name:string, input?:object, decision:'allow'|'deny', afterMs?:number}} RemoteAnswerStep
 * @typedef {{kind:'sendMessage', to:string, message:string}} SendMessageStep
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How many sessions each `crash` step with `times` has been played in, by its message. */
const CRASHES_FILE = 'fake-sdk-crashes.json'

/**
 * Which `crash` steps with `times` this session plays, decided once as the
 * session (the driver) is made: the first `times` sessions get the step, the
 * ones after skip it. The count lives in QCLOD_USER_DATA, since the app makes
 * a new driver per start. Without that folder there is nowhere to count, and
 * every such step crashes, as before.
 */
function crashingThisSession(script) {
  const dir = process.env.QCLOD_USER_DATA
  const counted = [...(script.steps ?? []), ...(script.nextTurn ?? [])].filter(
    (step) => step.kind === 'crash' && step.times !== undefined
  )
  if (!dir || counted.length === 0) return null
  const file = join(dir, CRASHES_FILE)
  let counts = {}
  try {
    counts = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Not written yet: no session has been made.
  }
  const crashing = new Set()
  const seen = new Set()
  for (const step of counted) {
    // Counted once per session, however many steps share the message.
    if (seen.has(step.message)) continue
    seen.add(step.message)
    const sessions = counts[step.message] ?? 0
    if (sessions < step.times) crashing.add(step.message)
    counts[step.message] = sessions + 1
  }
  writeFileSync(file, JSON.stringify(counts), 'utf8')
  return crashing
}

/** Whether a `crash` step fires in this session; `crashing` is from `crashingThisSession`. */
function crashes(step, crashing) {
  return step.times === undefined || crashing === null || crashing.has(step.message)
}

/**
 * A `crash` with `beforeInit` is an agent that dies before it introduces
 * itself — as one that is not logged in does: no `system/init`, no echo,
 * just the error, once it is given something to answer.
 */
function crashBeforeInit(turn, crashing) {
  for (const step of turn) {
    if (step.kind === 'crash' && step.beforeInit && crashes(step, crashing)) throw new Error(step.message)
  }
}

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

/** A task run's id as the CLI writes it (probe 05b): `0mwos8yev-fb27af7f`. */
function runId() {
  return `${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

/**
 * The relay instruction Qclod sends the main agent (stage 4, decision 5):
 * the address after `to:`, the message after the first blank line.
 */
function parseRelay(text) {
  const to = /через SendMessage \(to: "([^"]+)"\)/.exec(text ?? '')
  if (!to) return null
  const at = text.indexOf('\n\n')
  return { to: to[1], message: at >= 0 ? text.slice(at + 2) : '' }
}

export function createFakeSdk(script = {}) {
  const steps = script.steps ?? []
  // Decided as the session is made, so each session counts once.
  const crashing = crashingThisSession(script)
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

  /**
   * Subagents by task id (which is their agentId, probe 05b): what
   * backgroundTask(), stopTask() and SendMessage need of each. `phase`:
   * foreground — holding its Agent call; background — on its own; resuming —
   * a SendMessage will wake it after the turn; done; stopped.
   */
  const agents = new Map()
  /** SendMessage calls the main agent made: `{ to, message }`. */
  const relayed = []
  /** Every backgroundTask() and stopTask() argument, in order. */
  const backgroundedCalls = []
  const stoppedCalls = []
  /** SendMessage is a deferred tool (probe 05b): the first call is preceded by ToolSearch. */
  let sendMessageLoaded = false

  function registerAgent(fields) {
    const rec = { queued: [], runs: 1, signal: null, wake: null, ...fields }
    agents.set(rec.agentId, rec)
    return rec
  }

  /** Tells a foreground agent what to do now: background, stop. Wakes it from its hold. */
  function signalAgent(rec, signal) {
    rec.signal = signal
    const wake = rec.wake
    rec.wake = null
    wake?.()
  }

  /** The pause before a foreground agent's tool_result; a signal or dispose() cuts it short. */
  function holdAgent(rec, ms) {
    if (!ms || rec.signal) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        rec.wake = null
        resolve()
      }
      rec.wake = done
    })
  }

  function findAgent(ref) {
    return agents.get(ref) ?? [...agents.values()].find((a) => a.label && a.label === ref)
  }

  /**
   * A message of the subagent's own conversation, as CLI 2.1.317 forwards it
   * (probe 05b): every one carries the call's id, agent_id, subagent_type,
   * task_description and timestamp. Its stream_event never comes — only whole
   * messages; with forwardSubagentText false its text and thinking do not
   * either. null: the CLI would not forward it.
   */
  function subagentFrame(message, rec) {
    if (message.type === 'stream_event') return null
    if (message.type !== 'assistant' && message.type !== 'user') return message
    // A nested agent's own message: already marked with its id.
    if (message.agent_id) return message
    let marked = message
    if (message.type === 'assistant' && script.forwardSubagentText === false) {
      const content = (message.message?.content ?? []).filter((b) => b.type !== 'text' && b.type !== 'thinking')
      if (content.length === 0) return null
      marked = { ...message, message: { ...message.message, content } }
    }
    return {
      ...marked,
      parent_tool_use_id: rec.toolUseId,
      agent_id: rec.agentId,
      subagent_type: rec.subagentType,
      task_description: rec.description,
      timestamp: new Date().toISOString()
    }
  }

  function agentOutputFile(agentId) {
    return `C:\\Users\\fake\\AppData\\Local\\Temp\\claude\\tasks\\${agentId}.output`
  }

  function taskEvent(subtype, fields) {
    return { type: 'system', subtype, uuid: randomUUID(), session_id: sessionId, ...fields }
  }

  function agentProgress(rec, toolUseId, progress) {
    return taskEvent('task_progress', {
      task_id: rec.agentId,
      tool_use_id: toolUseId,
      description: progress.description ?? rec.description,
      subagent_type: rec.subagentType,
      usage: { total_tokens: progress.tokens, tool_uses: progress.toolUses, duration_ms: progress.durationMs },
      ...(progress.lastTool ? { last_tool_name: progress.lastTool } : {}),
      ...(progress.summary ? { summary: progress.summary } : {})
    })
  }

  /** What the agent says on reading a SendMessage: `resumeReply`, or «продолжил: <текст>». */
  function replyTo(message) {
    return script.resumeReply ?? `продолжил: ${message}`
  }

  function taskNotificationText(rec, toolUseId, status, summary) {
    return (
      '<task-notification>\n' +
      `<task-id>${rec.agentId}</task-id>\n` +
      `<tool-use-id>${toolUseId}</tool-use-id>\n` +
      `<output-file>${agentOutputFile(rec.agentId)}</output-file>\n` +
      `<status>${status}</status>\n` +
      `<summary>${summary}</summary>\n` +
      '</task-notification>'
    )
  }

  /**
   * The end of an agent running on its own (moved to the background, or
   * resumed by SendMessage), as probe 05b saw it: what it was sent meanwhile
   * answered at its next round, then task_updated, the notification, the
   * emptied list and the main agent's <task-notification>.
   */
  async function* finishAgent(rec, toolUseId, summary) {
    for (const message of rec.queued.splice(0)) {
      if (rec.phase !== 'background') return
      yield subagentFrame(assistant([{ type: 'text', text: replyTo(message) }]), rec)
    }
    if (rec.phase !== 'background') return
    rec.phase = 'done'
    yield taskEvent('task_updated', { task_id: rec.agentId, patch: { status: 'completed', end_time: Date.now() } })
    yield taskEvent('task_notification', {
      task_id: rec.agentId,
      tool_use_id: toolUseId,
      status: 'completed',
      output_file: agentOutputFile(rec.agentId),
      summary,
      usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 }
    })
    yield backgroundTasksChanged()
    yield {
      type: 'user',
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: taskNotificationText(rec, toolUseId, 'completed', summary) }
    }
  }

  /**
   * A finished agent woken by SendMessage, after the turn that sent it
   * (probe 05b): the same task_id with a new run_id, backgrounded, and the
   * SendMessage call's id as tool_use_id — while its own messages still
   * carry the original Agent call's id as parent_tool_use_id.
   */
  async function* resumeAgent(rec, message, sendId) {
    if (rec.phase !== 'resuming') return
    rec.phase = 'background'
    rec.runs += 1
    yield backgroundTasksChanged()
    yield taskEvent('task_started', {
      task_id: rec.agentId,
      run_id: runId(),
      tool_use_id: sendId,
      description: rec.description,
      subagent_type: rec.subagentType,
      task_type: 'local_agent',
      is_backgrounded: true,
      spawn_depth: rec.depth,
      prompt: message
    })
    if (rec.phase !== 'background') return
    const reply = replyTo(message)
    yield subagentFrame(assistant([{ type: 'text', text: reply }]), rec)
    yield agentProgress(rec, sendId, { tokens: 0, toolUses: 0, durationMs: 0 })
    yield* finishAgent(rec, sendId, reply)
  }

  /** REPLACE semantics: every shell and agent still running in the background, as sdk.d.ts describes it. */
  function backgroundTasksChanged() {
    return {
      type: 'system',
      subtype: 'background_tasks_changed',
      uuid: randomUUID(),
      session_id: sessionId,
      tasks: [
        ...[...shells]
          .filter(([, shell]) => !shell.stopped)
          .map(([taskId, shell]) => ({ task_id: taskId, task_type: 'local_bash', description: shell.description })),
        ...[...agents.values()]
          .filter((a) => a.phase === 'background')
          .map((a) => ({ task_id: a.agentId, task_type: 'local_agent', description: a.description }))
      ]
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

  /** Sends (and phone turns) waiting to be played as their own turn: `{ input, uuid? }`. */
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
    /** Every answer canUseTool gave: `{ name, behavior, message?, updatedInput? }`. */
    permissionLog: [],
    questionAnswers: [],
    executedTools: [],
    permissionMode: script.init?.permissionMode ?? 'default',
    model: script.init?.model ?? 'claude-opus-5',
    effort: null,
    interrupted: false,
    /** Uuids of the messages taken into a running turn. */
    folded: [],
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
    const answered = Promise.resolve(canUseTool(name, input, { toolUseID, signal: controller.signal })).then(
      (answer) => {
        state.permissionLog.push({
          name,
          behavior: answer.behavior,
          ...(answer.message !== undefined ? { message: answer.message } : {}),
          ...(answer.updatedInput !== undefined ? { updatedInput: answer.updatedInput } : {})
        })
        return answer
      }
    )
    try {
      return await Promise.race([answered, aborted])
    } finally {
      openAsks.delete(controller)
    }
  }

  /**
   * `echo: true`: what the agent got back, as a text message an end-to-end
   * test can read — the refusal's message, the answers, the notes, the plan.
   */
  function* echo(step, answer) {
    if (!step.echo) return
    const updated = answer.updatedInput ?? {}
    const got = {
      ...(answer.message !== undefined ? { message: answer.message } : {}),
      ...(updated.answers !== undefined ? { answers: updated.answers } : {}),
      ...(updated.annotations !== undefined ? { annotations: updated.annotations } : {}),
      ...(step.kind === 'plan' && updated.plan !== undefined ? { plan: updated.plan } : {})
    }
    yield assistant([{ type: 'text', text: `Получено: ${JSON.stringify(got)}` }])
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

  /** `ctx`: the subagent whose steps these are, for a nested one's parent_task_id and spawn_depth. */
  async function* play(stepList, ctx = null) {
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
          yield* echo(step, answer)
          break
        }

        // Plan mode's end: ExitPlanMode with the plan, asked about like any
        // tool. An approval runs the call with the plan it carries back
        // (updatedInput.plan — the user's edit, probe 05b); a refusal is an
        // errored tool_result with its message, as the CLI returns it.
        case 'plan': {
          const id = randomUUID()
          const input = { plan: step.plan }
          yield assistant([{ type: 'tool_use', id, name: 'ExitPlanMode', input }])
          const answer = await ask('ExitPlanMode', input, id)
          if (answer.behavior === 'allow') {
            const plan = answer.updatedInput?.plan ?? step.plan
            state.executedTools.push('ExitPlanMode')
            yield toolResult(id, `User has approved your plan.\n\n## Approved Plan:\n${plan}`)
          } else {
            yield toolResult(id, answer.message ?? 'отклонено', true)
          }
          yield* echo(step, answer)
          break
        }

        // Answered on the phone: Qclod's question is cancelled after afterMs
        // (control_cancel_request, so the signal aborts), and the turn goes
        // on by the decision made there.
        case 'remoteAnswer': {
          const id = randomUUID()
          const input = step.input ?? {}
          state.permissionRequests.push({ name: step.name, input })
          // Whatever Qclod answers is ignored: the phone answered. Wait for
          // the abort of this very signal, then follow the decision.
          const controller = new AbortController()
          openAsks.add(controller)
          canUseTool(step.name, input, { toolUseID: id, signal: controller.signal }).catch(() => undefined)
          await pause(step.afterMs ?? 50)
          controller.abort()
          openAsks.delete(controller)
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
          yield* echo(step, answer)
          break
        }

        case 'todo':
          yield* play([
            { kind: 'tool', name: 'TodoWrite', input: { todos: step.items }, result: 'ok' }
          ])
          break

        // A foreground agent, in the order probe 05b saw on CLI 2.1.317: the
        // call, task_started, its prompt as its own user message, its steps
        // (whole messages, marked with agent_id), progress, task_updated
        // completed, the notification — and only then the call's result.
        case 'subagent': {
          const id = randomUUID()
          const parent = ctx?.agent ?? null
          const prompt = step.prompt ?? step.name
          const rec = registerAgent({
            agentId: step.agentId ?? agentHexId(),
            toolUseId: id,
            description: step.name,
            subagentType: step.agentType ?? 'general-purpose',
            ...(step.label ? { label: step.label } : {}),
            depth: (ctx?.depth ?? 0) + 1,
            phase: 'foreground'
          })
          const started = taskEvent('task_started', {
            task_id: rec.agentId,
            run_id: runId(),
            tool_use_id: id,
            description: step.name,
            subagent_type: rec.subagentType,
            task_type: 'local_agent',
            is_backgrounded: false,
            spawn_depth: rec.depth,
            ...(parent ? { parent_task_id: parent.agentId } : {}),
            prompt
          })
          const report = step.report ?? 'подагент закончил'

          // A nested agent whose calls the CLI does not forward: only its
          // task events reach the stream (stage 4, Review Focus 5).
          if (parent && script.nestedToolCalls === false) {
            yield started
            rec.phase = 'done'
            yield taskEvent('task_notification', {
              task_id: rec.agentId,
              tool_use_id: id,
              status: 'completed',
              output_file: agentOutputFile(rec.agentId),
              summary: report
            })
            break
          }

          yield assistant([
            {
              type: 'tool_use',
              id,
              // The real subagent tool: «Task» does not exist in this SDK.
              name: 'Agent',
              input: {
                description: step.name,
                ...(step.agentType ? { subagent_type: step.agentType } : {}),
                prompt,
                ...(step.label ? { name: step.label } : {})
              }
            }
          ])
          yield started
          yield subagentFrame(
            { type: 'user', uuid: randomUUID(), session_id: sessionId, message: { role: 'user', content: prompt } },
            rec
          )
          for await (const nested of play(step.steps ?? [], { agent: rec, depth: rec.depth })) {
            const frame = subagentFrame(nested, rec)
            if (frame) yield frame
            if (rec.signal) break
          }
          for (const progress of step.progress ?? []) {
            if (rec.signal) break
            yield agentProgress(rec, id, progress)
          }
          await holdAgent(rec, step.holdMs)

          // backgroundTask(), or a 'now' message (probe 05b, 3b and 3c): the
          // call returns async_launched at once, the rest comes after the turn.
          if (rec.signal === 'background') {
            rec.signal = null
            rec.phase = 'background'
            yield backgroundTasksChanged()
            yield taskEvent('task_updated', { task_id: rec.agentId, patch: { is_backgrounded: true } })
            yield {
              ...toolResult(id, [
                {
                  type: 'text',
                  text:
                    'Async agent launched successfully.\n' +
                    `agentId: ${rec.agentId} (internal ID - do not mention to user.)\n` +
                    'The agent is working in the background. ' +
                    'You will be notified automatically when it completes.'
                }
              ]),
              tool_use_result: {
                isAsync: true,
                status: 'async_launched',
                agentId: rec.agentId,
                description: step.name,
                ...(step.model ? { resolvedModel: step.model } : {}),
                prompt,
                outputFile: agentOutputFile(rec.agentId),
                canReadOutputFile: true,
                canContinueAgent: true
              }
            }
            // stopTask() right after backgroundTask(): it ends in the background (probe 05b, 3b).
            if (rec.stopAfterMove) {
              rec.phase = 'stopped'
              yield taskEvent('task_updated', { task_id: rec.agentId, patch: { status: 'killed', end_time: Date.now() } })
              yield taskEvent('task_notification', {
                task_id: rec.agentId,
                tool_use_id: id,
                status: 'stopped',
                output_file: agentOutputFile(rec.agentId),
                summary: step.name
              })
              yield backgroundTasksChanged()
              break
            }
            afterTurn.push(() => finishAgent(rec, id, report))
            break
          }

          // stopTask() (probe 05b, 3a): killed, stopped, and the call errs.
          if (rec.signal === 'stop') {
            rec.signal = null
            rec.phase = 'stopped'
            yield taskEvent('task_updated', { task_id: rec.agentId, patch: { status: 'killed', end_time: Date.now() } })
            yield taskEvent('task_notification', {
              task_id: rec.agentId,
              tool_use_id: id,
              status: 'stopped',
              output_file: agentOutputFile(rec.agentId),
              summary: step.name
            })
            yield toolResult(id, 'Error: [Request interrupted by user for tool use]', true)
            break
          }

          rec.phase = 'done'
          yield taskEvent('task_updated', { task_id: rec.agentId, patch: { status: 'completed', end_time: Date.now() } })
          yield taskEvent('task_notification', {
            task_id: rec.agentId,
            tool_use_id: id,
            status: 'completed',
            output_file: agentOutputFile(rec.agentId),
            summary: report,
            usage: {
              total_tokens: step.stats?.totalTokens ?? 0,
              tool_uses: step.stats?.totalToolUseCount ?? 0,
              duration_ms: step.stats?.totalDurationMs ?? 0
            }
          })
          // What the agent wrote back: the step's own report, line breaks and all.
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
              agentId: rec.agentId,
              ...(step.model ? { resolvedModel: step.model } : {}),
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
              prompt,
              content: [{ type: 'text', text: report }]
            }
          }
          break
        }

        // The main agent writes to a subagent (probe 05b): SendMessage is a
        // deferred tool, loaded by ToolSearch before its first call. A working
        // agent gets it at its next round; a finished one is resumed after
        // the turn.
        case 'sendMessage': {
          if (!sendMessageLoaded) {
            sendMessageLoaded = true
            yield* play([{ kind: 'tool', name: 'ToolSearch', input: { query: 'select:SendMessage' }, result: 'SendMessage' }])
          }
          const id = randomUUID()
          yield assistant([
            {
              type: 'tool_use',
              id,
              name: 'SendMessage',
              input: { to: step.to, message: step.message, summary: step.message.slice(0, 60) }
            }
          ])
          relayed.push({ to: step.to, message: step.message })
          const rec = findAgent(step.to)
          if (!rec) {
            yield toolResult(id, `Error: no agent "${step.to}"`, true)
            break
          }
          let answer
          if (rec.phase === 'foreground' || rec.phase === 'background' || rec.phase === 'resuming') {
            rec.queued.push(step.message)
            answer = {
              success: true,
              message:
                `Message queued for delivery to ${step.to} at its next tool round. ` +
                'If it finishes first, it is resumed with the message and notifies again.'
            }
          } else {
            rec.phase = 'resuming'
            afterTurn.push(() => resumeAgent(rec, step.message, id))
            answer = { success: true, message: `Resuming agent ${rec.agentId}`, resumedAgentId: rec.agentId }
          }
          yield { ...toolResult(id, [{ type: 'text', text: JSON.stringify(answer) }]), tool_use_result: answer }
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
          const rec = registerAgent({
            agentId,
            toolUseId: id,
            description,
            subagentType,
            depth: (ctx?.depth ?? 0) + 1,
            phase: 'background'
          })
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
            run_id: runId(),
            tool_use_id: id,
            description,
            subagent_type: subagentType,
            task_type: 'local_agent',
            is_backgrounded: true,
            spawn_depth: rec.depth,
            ...(ctx?.agent ? { parent_task_id: ctx.agent.agentId } : {}),
            prompt: description
          }

          afterTurn.push(async function* () {
            for (const progress of step.progress ?? []) {
              await between()
              // Stopped meanwhile: stopTask() has said all there is.
              if (rec.phase !== 'background') return
              yield agentProgress(rec, id, { ...progress, description })
            }
            const finish = step.finish
            // finish: null — the agent never ends, and nothing says it did.
            if (!finish) return
            await between()
            for (const message of rec.queued.splice(0)) {
              if (rec.phase !== 'background') return
              yield subagentFrame(assistant([{ type: 'text', text: replyTo(message) }]), rec)
            }
            if (rec.phase !== 'background') return
            rec.phase = finish.status === 'stopped' ? 'stopped' : 'done'
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

        // The subscription limit, as the SDK's types and errors document it (not
        // seen on a live session): rejected, the assistant's error, and a result
        // with is_error — the last one is made when the turn ends.
        case 'limitHit': {
          limitPlays += 1
          if (step.times !== undefined && limitPlays > step.times) break
          const resetsAt = Date.now() + step.resetsInMs
          const text = `You've hit your session limit · resets ${new Date(resetsAt).toISOString()}`
          yield {
            type: 'rate_limit_event',
            uuid: randomUUID(),
            session_id: sessionId,
            rate_limit_info: {
              status: 'rejected',
              resetsAt: Math.floor(resetsAt / 1000),
              rateLimitType: step.type ?? 'five_hour'
            }
          }
          yield {
            ...assistant([{ type: 'text', text }]),
            error: 'rate_limit'
          }
          turn.limitText = text
          break
        }

        case 'crash':
          // A beforeInit crash was settled before the turn began.
          if (step.beforeInit || !crashes(step, crashing)) break
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


  // ---- The CLI's own message queue -------------------------------------
  // Applies to messages sent with a uuid; a send without one keeps the plain
  // inbox behaviour (its own turn, no frames).

  /** false: a CLI without msg_lifecycle_v1 — no frames, no receipt, no cancel. */
  const lifecycle = script.lifecycle !== false
  /** false: a receipt, but no interrupt_cancel_queued_v1 — the flag is not heard. */
  const cancelsOnInterrupt = script.cancelQueuedOnInterrupt !== false
  /** Messages sent mid-turn, waiting for the next step boundary: `{ input, uuid }`. */
  const pending = []
  /** The turn being played, or null between turns: `{ starter, folded, aborted }`. */
  let turn = null
  /** How many times a `limitHit` step has come up in this session, for its `times`. */
  let limitPlays = 0
  let phoneCancelTimer = null

  function lifecycleFrame(stateName, commandUuid) {
    return {
      type: 'command_lifecycle',
      command_uuid: commandUuid,
      state: stateName,
      uuid: randomUUID(),
      session_id: sessionId
    }
  }

  /** A lifecycle frame inside the turn's own stream. */
  function* announce(stateName, commandUuid) {
    if (lifecycle && commandUuid) yield lifecycleFrame(stateName, commandUuid)
  }

  /** Whoever is still waiting for the CLI to take them, 'now' first. */
  function waitingUuids() {
    return [...inbox.filter((e) => e.uuid).map((e) => e.uuid), ...pending.map((p) => p.uuid)]
  }

  /** What the CLI's cancelAsyncMessage answers: true, false, or null for a CLI without it. */
  function cancelAsync(uuid) {
    if (!lifecycle) return null
    let at = pending.findIndex((p) => p.uuid === uuid)
    if (at >= 0) {
      pending.splice(at, 1)
    } else {
      at = inbox.findIndex((e) => e.uuid === uuid)
      if (at < 0) return false
      inbox.splice(at, 1)
    }
    pushOutOfBand(lifecycleFrame('cancelled', uuid))
    return true
  }

  /**
   * `now`: a message sent with priority 'now' cuts the turn, and the CLI
   * moves a foreground agent to the background by itself (probe 05b, 3c);
   * with background tasks disabled it is stopped instead. An interrupt stops
   * a foreground agent with the turn — not taken from a live CLI.
   */
  function abortTurn(reason = 'interrupt') {
    state.interrupted = true
    for (const controller of openAsks) controller.abort()
    if (turn) turn.aborted = true
    for (const rec of agents.values()) {
      if (rec.phase !== 'foreground' || rec.signal) continue
      signalAgent(rec, reason === 'now' && !script.backgroundTasksDisabled ? 'background' : 'stop')
    }
  }

  /**
   * The model obeying Qclod's relay instruction (stage 4, decision 5): a
   * SendMessage to the agent it names, with the text after the blank line.
   * `relay: false` — the model did not listen; the text is just text.
   */
  function relaySteps(input) {
    if (script.relay === false) return []
    const relay = parseRelay(input?.text)
    return relay ? [{ kind: 'sendMessage', to: relay.to, message: relay.message }] : []
  }

  /** The foreign `cancelled` frame a phone sends, once, after the first message. */
  function armPhoneCancel() {
    if (!lifecycle || !script.phoneCancel || phoneCancelTimer) return
    phoneCancelTimer = setTimeout(
      () => pushOutOfBand(lifecycleFrame('cancelled', script.phoneCancel.uuid)),
      script.phoneCancel.afterMs ?? 0
    )
    phoneCancelTimer.unref?.()
  }

  /**
   * The step boundary: what was sent mid-turn is taken into the turn, and
   * the model answers it right there, before the turn's own steps go on —
   * as the live CLI does (05a-queue-probe §1: `started(B)`, the reply to B,
   * `completed(B)`, `result`). The answer is the message's own `turns[i]`
   * (or `nextTurn`), counted like a message that starts a turn.
   */
  async function* foldPending() {
    while (pending.length > 0) {
      if (turn.aborted) return
      const { uuid, input } = pending.shift()
      turn.folded.push(uuid)
      state.folded.push(uuid)
      yield* announce('started', uuid)
      const reply = [...relaySteps(input), ...(script.turns?.[answered] ?? script.nextTurn ?? [])]
      answered += 1
      yield* playTurn(reply)
    }
  }

  /** A turn's steps, with a boundary after each one where the queue and an interrupt are heard. */
  async function* playTurn(stepList) {
    for (const step of stepList) {
      if (turn.aborted) return
      yield* play([step])
      if (turn.aborted) return
      yield* foldPending()
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
      // Probe 05b: init calls the subagent tool «Task»; the stream calls it «Agent».
      tools: ['Read', 'Edit', 'Bash', 'Task', ...(script.noSendMessage ? [] : ['SendMessage']), 'ToolSearch'],
      claude_code_version: script.init?.claudeCodeVersion ?? (lifecycle ? '2.1.317' : '2.1.200'),
      ...(lifecycle
        ? {
            capabilities: [
              'interrupt_receipt_v1',
              ...(cancelsOnInterrupt ? ['interrupt_cancel_queued_v1'] : []),
              'interrupt_send_now_v1',
              'msg_lifecycle_v1'
            ]
          }
        : {})
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
      crashBeforeInit(steps, crashing)
      turn = { starter: undefined, folded: [], aborted: false }
      yield* introduce()
      yield* playTurn(steps)
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
      const entry = inbox.shift()
      if (!entry) continue
      const input = entry.input
      turn = { starter: entry.uuid, folded: [], aborted: false }

      crashBeforeInit(script.nextTurn ?? [], crashing)
      // R7a: the lifecycle frames come before init, which comes with the first turn.
      yield* announce('started', entry.uuid)
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
      let turnSteps
      if (input.phone) {
        turnSteps = input.steps ?? script.nextTurn ?? []
      } else {
        turnSteps = [...relaySteps(input), ...(script.turns?.[answered] ?? script.nextTurn ?? [])]
        answered += 1
      }
      yield* playTurn(turnSteps)
      yield* finishTurn()
      yield* drainAfterTurn()
    }
  }

  async function* finishTurnImpl() {
    const ended = turn
    turn = null
    // What arrived after the last boundary is its own turn, behind any 'now'.
    inbox.push(...pending.splice(0))
    // Counted before the result goes out: the app asks for the context the
    // moment it sees the result.
    state.turnsDone += 1
    // A folded message is done before the result; the starter's frame follows it.
    for (const uuid of ended.folded) yield* announce('completed', uuid)
    const uuids = [ended.starter, ...ended.folded].filter(Boolean)
    yield {
      type: 'result',
      ...(ended.aborted
        ? { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' }
        : { subtype: 'success', is_error: ended.limitText !== undefined }),
      uuid: randomUUID(),
      session_id: sessionId,
      num_turns: 1,
      duration_ms: 1234,
      total_cost_usd: script.costUsd ?? 0.0421,
      usage: {
        input_tokens: 12,
        output_tokens: 240,
        cache_creation_input_tokens: 1400,
        cache_read_input_tokens: 44022
      },
      ...(ended.aborted ? {} : { result: ended.limitText ?? 'done' }),
      ...(uuids.length > 0 ? { user_message_uuids: uuids } : {}),
      queued_turn_count: inbox.length
    }
    yield* announce(ended.aborted ? 'cancelled' : 'completed', ended.starter)
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
    inbox.push({ input: { phone: true, text, steps: phoneSteps } })
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
    async cancelQueued(uuid) {
      return cancelAsync(uuid)
    },
    /** The SDK's own name for it; cancelQueued calls the same thing. */
    async cancelAsyncMessage(uuid) {
      return cancelAsync(uuid)
    },
    send(input, opts) {
      state.sent.push(input)
      const uuid = opts?.uuid
      if (uuid === undefined) {
        inbox.push({ input })
        wakeStream()
        return
      }
      armPhoneCancel()
      if (lifecycle) pushOutOfBand(lifecycleFrame('queued', uuid))
      if (!turn) {
        inbox.push({ input, uuid })
        wakeStream()
      } else if (opts.priority === 'now') {
        // The simplified model: the running turn is cut short, this starts the next.
        inbox.unshift({ input, uuid })
        abortTurn('now')
      } else {
        pending.push({ input, uuid })
      }
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
    async interrupt(opts) {
      abortTurn()
      if (!lifecycle) return undefined
      const waiting = waitingUuids()
      if (!cancelsOnInterrupt) return { stillQueued: waiting }
      if (!opts?.cancelQueued) return { stillQueued: waiting, cancelled: [] }
      for (const uuid of waiting) cancelAsync(uuid)
      return { stillQueued: [], cancelled: waiting }
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
      // The rows follow the percent, so the legend agrees with the bar's
      // number: used is split 30:12 as at the default 21% (42 000), the
      // reserve keeps its 9 000 while there is room, and free is the rest.
      const max = 200000
      const used = Math.round((contextPercentNow() / 100) * max)
      const messages = Math.round((used * 30) / 42)
      const buffer = Math.min(9000, max - used)
      return {
        model: state.model,
        totalTokens: used,
        maxTokens: max,
        percentage: contextPercentNow(),
        categories: [
          { name: 'messages', tokens: messages, kind: 'used' },
          { name: 'system_prompt', tokens: used - messages, kind: 'used' },
          { name: 'Autocompact buffer', tokens: buffer, kind: 'buffer' },
          { name: 'Free space', tokens: max - used - buffer, kind: 'free' },
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
      stoppedCalls.push(taskId)
      // A CLI that refuses: the task goes on as if nothing was asked.
      if (script.stopTaskError) throw new Error(script.stopTaskError)
      const rec = agents.get(taskId)
      if (rec) {
        // In the foreground its end comes in the turn's own stream (probe 05b, 3a).
        if (rec.phase === 'foreground') {
          // Being moved to the background: the stop lands there, once it has moved.
          if (rec.signal === 'background') rec.stopAfterMove = true
          else if (script.foregroundStop !== 'ignored' && !rec.signal) signalAgent(rec, 'stop')
          return
        }
        if (rec.phase !== 'background' && rec.phase !== 'resuming') return
        rec.phase = 'stopped'
        // Probe 05b, 3b: killed, stopped, and the list without it.
        pushOutOfBand(taskEvent('task_updated', { task_id: taskId, patch: { status: 'killed', end_time: Date.now() } }))
        pushOutOfBand(
          taskEvent('task_notification', {
            task_id: taskId,
            tool_use_id: rec.toolUseId,
            status: 'stopped',
            output_file: agentOutputFile(taskId),
            summary: rec.description
          })
        )
        pushOutOfBand(backgroundTasksChanged())
        return
      }
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
    /**
     * Moves the foreground agent of this Agent call to the background (probe
     * 05b, 3b): true — moved; false — no such agent in the foreground.
     * `backgroundTasksDisabled` — rejects, as a CLI with background tasks off.
     */
    async backgroundTask(toolUseId) {
      backgroundedCalls.push(toolUseId)
      if (script.backgroundTasksDisabled) throw new Error('background tasks are disabled')
      const rec = [...agents.values()].find((a) => a.toolUseId === toolUseId && a.phase === 'foreground' && !a.signal)
      if (!rec) return false
      signalAgent(rec, 'background')
      return true
    },
    async dispose() {
      state.disposed = true
      closed = true
      // A held agent's timer would keep the process up.
      for (const rec of agents.values()) rec.wake?.()
      if (phoneCancelTimer) clearTimeout(phoneCancelTimer)
      if (wake) {
        const resume = wake
        wake = null
        resume()
      }
    },

    get sent() {
      return state.sent
    },
    get relayed() {
      return relayed
    },
    get backgrounded() {
      return backgroundedCalls
    },
    get stopped() {
      return stoppedCalls
    },
    get remoteCalls() {
      return remoteCalls
    },
    get permissionRequests() {
      return state.permissionRequests
    },
    get permissionLog() {
      return state.permissionLog
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
    get folded() {
      return state.folded
    },
    get interrupted() {
      return state.interrupted
    },
    get disposed() {
      return state.disposed
    }
  }
}
