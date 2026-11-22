// Live probe: what the Claude Code stream and the Agent SDK give about subagents.
// Run by hand: node scripts/probe-subagents.mjs <1|2|3a|3b|3c|4|5>  > log.txt
// Every frame is logged as one JSON line with a timestamp. Needs the user's installed `claude`.
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const SDK = 'C:/Users/sojuse/qclod/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
const { query } = await import(pathToFileURL(SDK).href)
const AGENT =
  'C:/Users/sojuse/AppData/Local/Microsoft/WinGet/Packages/Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe/claude.exe'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function channel() {
  const buf = []
  let wake = null
  let closed = false
  return {
    push(m) { buf.push(m); wake?.(); wake = null },
    end() { closed = true; wake?.(); wake = null },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buf.length) { yield buf.shift(); continue }
        if (closed) return
        await new Promise((r) => (wake = r))
      }
    }
  }
}

const userMsg = (text, extra = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  ...extra
})

function compactStreamEvent(m) {
  const e = m.event ?? {}
  return {
    parent_tool_use_id: m.parent_tool_use_id, agent_id: m.agent_id, subagent_type: m.subagent_type,
    ev: e.type, block: e.content_block?.type, name: e.content_block?.name, delta: e.delta?.type,
    text: (e.delta?.text ?? e.delta?.thinking ?? e.delta?.partial_json ?? '').slice(0, 60)
  }
}

async function scenario(label, driver, opts = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'qclod-subprobe-'))
  const t0 = Date.now()
  const ts = () => ((Date.now() - t0) / 1000).toFixed(2)
  const log = (kind, obj) => console.log(JSON.stringify({ t: Number(ts()), kind, data: obj }))
  console.log(JSON.stringify({ t: 0, kind: 'SCENARIO', data: { label, cwd } }))
  const input = channel()
  const q = query({
    prompt: input,
    options: {
      cwd,
      model: 'haiku',
      pathToClaudeCodeExecutable: AGENT,
      maxTurns: 12,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      perTaskStopAffordance: true,
      includePartialMessages: true,
      canUseTool: async (name, inp) => {
        log('CAN_USE_TOOL', { name, input: inp })
        if (name === 'Bash' && !/^\s*(echo|sleep)\b/.test(String(inp?.command))) return { behavior: 'deny', message: 'probe allows echo/sleep only' }
        return { behavior: 'allow', updatedInput: inp }
      }
    }
  })
  const send = (m) => { log('SEND', { uuid: m.uuid, priority: m.priority, origin: m.origin, text: m.message.content[0].text }); input.push(m) }
  const hard = setTimeout(() => { log('TIMEOUT', 'hard 170s'); try { q.close() } catch {} }, 170000)
  const ctx = { send, log, ts, q, input, sleep, userMsg, frames: [], cwd, sessionId: null }
  const reader = (async () => {
    try {
      for await (const m of q) {
        ctx.frames.push(m)
        if (m.type === 'system' && m.subtype === 'init') {
          ctx.sessionId = m.session_id
          log('FRAME init', { claude_code_version: m.claude_code_version, capabilities: m.capabilities, tools: m.tools, model: m.model, permissionMode: m.permissionMode, session_id: m.session_id })
        } else if (m.type === 'stream_event') {
          log('FRAME stream_event', compactStreamEvent(m))
        } else if (m.type === 'result') {
          const { usage, modelUsage, ...rest } = m
          log('FRAME result', rest)
        } else if (m.type === 'system' && /^(hook_|commands_changed|thinking_tokens)/.test(m.subtype)) {
          log(`FRAME system/${m.subtype}`, '(elided)')
        } else if (m.type === 'rate_limit_event') {
          log('FRAME rate_limit_event', '(elided)')
        } else {
          log(`FRAME ${m.type}${m.subtype ? '/' + m.subtype : ''}`, m)
        }
      }
    } catch (e) { log('READER ERROR', String(e)) }
    log('READER END', {})
  })()
  try { await driver(ctx) } catch (e) { log('DRIVER ERROR', String(e?.stack ?? e)) }
  await Promise.race([reader, sleep(opts.drain ?? 20000)])
  clearTimeout(hard)
  try { q.close() } catch {}
  log('CLOSED', {})
  return ctx
}

const waitFor = async (ctx, pred, ms = 60000) => {
  const s = Date.now()
  while (Date.now() - s < ms) { const f = ctx.frames.find(pred); if (f) return f; await sleep(100) }
  return null
}
const isStarted = (m) => m.type === 'system' && m.subtype === 'task_started'
const results = (ctx) => ctx.frames.filter((m) => m.type === 'result').length
const waitResults = async (ctx, n, ms = 90000) => {
  const s = Date.now()
  while (Date.now() - s < ms) { if (results(ctx) >= n) return true; await sleep(100) }
  return false
}

function dumpDisk(ctx) {
  const root = join(homedir(), '.claude', 'projects')
  if (!ctx.sessionId || !existsSync(root)) return ctx.log('DISK', { error: 'no session or projects root' })
  for (const d of readdirSync(root)) {
    const sub = join(root, d, ctx.sessionId, 'subagents')
    if (!existsSync(sub)) continue
    const files = readdirSync(sub)
    ctx.log('DISK dir', { sub, files })
    for (const f of files) {
      const p = join(sub, f)
      const st = statSync(p)
      if (f.endsWith('.meta.json')) { ctx.log('DISK meta', { f, content: readFileSync(p, 'utf8') }); continue }
      const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } })
      ctx.log('DISK jsonl', {
        f, size: st.size, lines: lines.length,
        keys: [...new Set(lines.flatMap((l) => Object.keys(l ?? {})))],
        timestamps: lines.map((l) => l?.timestamp ?? null),
        types: lines.map((l) => l?.type),
        sample: lines[0] ? { ...lines[0], message: JSON.stringify(lines[0].message).slice(0, 200) } : null
      })
    }
  }
}

const P_FWD = 'Launch one subagent with the Agent tool: subagent_type general-purpose, name "счётчик", description "count", prompt: "Write three sentences about the number 7, then call Bash with `echo 7`." Wait for it, then reply with the single word done.'
const P_FG_SLEEP = 'Launch one subagent with the Agent tool: subagent_type general-purpose, run_in_background false, description "slow", prompt: "Call Bash with exactly `echo start && sleep 60`, then reply done." Wait for it, then reply with the single word done.'
const relay = (ref, text) => `Передай агенту ${ref} через SendMessage (to: "${ref}") это сообщение от пользователя, дословно:\n\n${text}`

const which = process.argv[2]
let cwdToClean = null
const finish = (ctx) => { cwdToClean = ctx.cwd }

if (which === '1' || which === '2') {
  const ctx = await scenario(`scenario ${which}`, async (ctx) => {
    ctx.send(userMsg(P_FWD, { uuid: randomUUID() }))
    const st = await waitFor(ctx, isStarted)
    ctx.log('NOTE task_started', { task_id: st?.task_id, run_id: st?.run_id, tool_use_id: st?.tool_use_id })
    await waitResults(ctx, 1)
    await sleep(2000)
    if (which === '2') {
      const ref = st?.task_id
      ctx.log('NOTE init.tools has SendMessage', { has: ctx.frames.find((m) => m.subtype === 'init')?.tools?.includes('SendMessage') })
      ctx.send(userMsg(relay(ref, 'напиши одно предложение о числе 8 и вызови Bash `echo 8`'), { uuid: randomUUID(), priority: 'next' }))
      await waitResults(ctx, 2)
      await sleep(5000)
    }
    ctx.input.end()
  })
  dumpDisk(ctx)
  finish(ctx)
}

if (which === '3a' || which === '3b' || which === '3c') {
  const ctx = await scenario(`scenario ${which}`, async (ctx) => {
    ctx.send(userMsg(P_FG_SLEEP, { uuid: randomUUID() }))
    const st = await waitFor(ctx, isStarted)
    ctx.log('NOTE task_started', { task_id: st?.task_id, tool_use_id: st?.tool_use_id, is_backgrounded: st?.is_backgrounded })
    await sleep(10000)
    if (which === '3a') {
      try { await ctx.q.stopTask(st.task_id); ctx.log('stopTask returned', {}) } catch (e) { ctx.log('stopTask threw', String(e)) }
      await sleep(15000)
    } else if (which === '3b') {
      try { const r = await ctx.q.backgroundTasks(st.tool_use_id); ctx.log('backgroundTasks(tool_use_id) returned', { r }) } catch (e) { ctx.log('backgroundTasks threw', String(e)) }
      await sleep(5000)
      try { await ctx.q.stopTask(st.task_id); ctx.log('stopTask returned', {}) } catch (e) { ctx.log('stopTask threw', String(e)) }
      await sleep(15000)
    } else {
      ctx.send(userMsg(relay(st.task_id, 'напиши одно слово: привет'), { uuid: randomUUID(), priority: 'now', origin: { kind: 'human' } }))
      await sleep(20000)
      try { await ctx.q.stopTask(st.task_id) } catch (e) { ctx.log('cleanup stopTask threw', String(e)) }
      await sleep(5000)
    }
    ctx.input.end()
  })
  finish(ctx)
}

if (which === '4') {
  const ctx = await scenario('scenario 4 nested', async (ctx) => {
    ctx.send(userMsg('Launch one subagent with the Agent tool (general-purpose, description "outer"). Its prompt: "Launch one subagent with the Agent tool (general-purpose, description inner) whose prompt is: call Bash with `echo 7`. Then reply done." Wait for it, then reply with the single word done.', { uuid: randomUUID() }))
    await waitResults(ctx, 1, 120000)
    await sleep(2000)
    ctx.input.end()
  })
  finish(ctx)
}

if (which === '5') {
  const ctx = await scenario('scenario 5 interrupt with background agent', async (ctx) => {
    ctx.send(userMsg('Launch one subagent with the Agent tool: general-purpose, run_in_background true, description "bg", prompt: "Call Bash with exactly `echo start && sleep 45`, then reply done." After launching reply with the single word started.', { uuid: randomUUID() }))
    const st = await waitFor(ctx, isStarted)
    ctx.log('NOTE task_started', { task_id: st?.task_id, tool_use_id: st?.tool_use_id, is_backgrounded: st?.is_backgrounded })
    await sleep(8000)
    try { await ctx.q.interrupt(); ctx.log('interrupt returned', {}) } catch (e) { ctx.log('interrupt threw', String(e)) }
    const before = ctx.frames.length
    await sleep(15000)
    ctx.log('NOTE frames after interrupt', { count: ctx.frames.length - before })
    try { await ctx.q.stopTask(st.task_id) } catch (e) { ctx.log('cleanup stopTask threw', String(e)) }
    await sleep(4000)
    ctx.input.end()
  })
  finish(ctx)
}

if (cwdToClean) { try { rmSync(cwdToClean, { recursive: true, force: true }) } catch {} }
process.exit(0)
