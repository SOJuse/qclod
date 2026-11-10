/**
 * Session transcripts on disk, the way the CLI writes them.
 *
 * Resuming a session reads its JSONL file, so tests need files that look like
 * the real ones: same folder layout, same raw camelCase lines (`parentUuid`,
 * `isSidechain`, `toolUseResult`, `compactMetadata`…). The shapes here were
 * taken from live transcripts of CLI 2.1.268–2.1.317; nothing is invented.
 *
 * Written as .mjs so unit tests and e2e setup share it without a build step.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The project folder name the CLI derives from a cwd (`sl()` in sdk.mjs). */
export function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function writeJsonl(path, lines) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map((line) => JSON.stringify(line) + '\n').join(''))
}

/**
 * Writes `<configDir>/projects/<project>/<sessionId>.jsonl` and, per subagent,
 * `<sessionId>/subagents/agent-<agentId>.jsonl` with its `.meta.json`.
 * Returns the main file's path.
 */
export function writeTranscript(configDir, cwd, sessionId, lines, subagents = {}) {
  const project = join(configDir, 'projects', encodeProjectDir(cwd))
  const main = join(project, `${sessionId}.jsonl`)
  writeJsonl(main, lines)
  for (const [agentId, agent] of Object.entries(subagents)) {
    const base = join(project, sessionId, 'subagents', `agent-${agentId}`)
    writeJsonl(`${base}.jsonl`, agent.lines)
    writeFileSync(`${base}.meta.json`, JSON.stringify(agent.meta))
  }
  return main
}

const EXPLORE_ID = 'a1c4e7b2d9f0a3b56'
const TESTS_ID = 'a2b8d1f4c7e0a9d32'
const LONG_REVIEW_ID = 'a3f2a6c9e1b4d7f08'

const NOTIFICATION =
  '<task-notification>\n' +
  `<task-id>${TESTS_ID}</task-id>\n` +
  '<tool-use-id>toolu_01TestsRun8bQf2Lx9Kd3Vw7</tool-use-id>\n' +
  `<output-file>C:\\Users\\u\\AppData\\Local\\Temp\\claude\\tasks\\${TESTS_ID}.output</output-file>\n` +
  '<status>completed</status>\n' +
  '<summary>Agent "Прогон тестов" finished</summary>\n' +
  '<usage><subagent_tokens>93175</subagent_tokens><tool_uses>18</tool_uses>' +
  '<duration_ms>110172</duration_ms></usage>\n' +
  '</task-notification>'

/**
 * A finished session for the resume tests: foreground and background
 * subagents, an auto-compaction, a failed subagent, one that never reported
 * back, and a branch cut off by a rewind. `lines` is the main file in write
 * order; `subagents` maps agentId to its meta and lines.
 */
export function resumedSession(sessionId, cwd) {
  let n = 0
  let clock = Date.parse('2026-11-09T10:00:00.000Z')
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
  const stamp = () => new Date((clock += 1500)).toISOString()
  const common = () => ({
    userType: 'external',
    entrypoint: 'sdk-ts',
    cwd,
    sessionId,
    version: '2.1.317',
    gitBranch: 'HEAD'
  })

  const lines = []
  let last = null

  /** Appends a conversation line chained to the previous one. */
  function add(fields, { parent = last, chain = true } = {}) {
    const line = {
      parentUuid: parent,
      isSidechain: false,
      ...fields,
      uuid: uuid(),
      timestamp: stamp(),
      ...common()
    }
    lines.push(line)
    if (chain) last = line.uuid
    return line
  }

  const user = (content, extra = {}) =>
    add({ type: 'user', message: { role: 'user', content }, ...extra })

  const assistant = (content, usage) =>
    add({
      type: 'assistant',
      message: {
        model: 'claude-opus-5',
        id: `msg_${String(n + 1).padStart(24, '0')}`,
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: usage ?? {
          input_tokens: 4,
          cache_creation_input_tokens: 900,
          cache_read_input_tokens: 21000,
          output_tokens: 120
        }
      }
    })

  const agentCall = (id, input) => assistant([{ type: 'tool_use', id, name: 'Agent', input }])

  const toolResult = (id, content, toolUseResult, isError = false) =>
    user(
      [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
      { toolUseResult }
    )

  const launched = (agentId, description) => ({
    isAsync: true,
    status: 'async_launched',
    agentId,
    description,
    prompt: description,
    outputFile: `C:\\Users\\u\\AppData\\Local\\Temp\\claude\\tasks\\${agentId}.output`,
    canReadOutputFile: true
  })

  const launchedText = (agentId) => [
    {
      type: 'text',
      text:
        'Async agent launched successfully.\n' +
        `agentId: ${agentId} (internal ID - do not mention to user.)\n` +
        'The agent is working in the background. ' +
        'You will be notified automatically when it completes.'
    }
  ]

  lines.push({
    type: 'file-history-snapshot',
    messageId: '00000000-0000-4000-8000-000000000001',
    snapshot: {
      messageId: '00000000-0000-4000-8000-000000000001',
      trackedFileBackups: {},
      timestamp: '2026-11-09T10:00:01.500Z'
    },
    isSnapshotUpdate: false
  })

  // 1. The question and the first answer.
  user('найди, где падает вставка', { origin: { kind: 'human' }, promptSource: 'typed' })
  const firstAnswer = assistant([{ type: 'text', text: 'смотрю' }])

  // 8. A branch the person rewound past: written then, never continued.
  add(
    {
      type: 'user',
      message: { role: 'user', content: 'старый вариант' },
      origin: { kind: 'human' },
      promptSource: 'typed'
    },
    { parent: firstAnswer.uuid, chain: false }
  )

  // 2. A foreground Explore subagent.
  const exploreCall = 'toolu_01ExplorePaste4mNc7Rt2Qz'
  agentCall(exploreCall, {
    description: 'Обзор вставки',
    prompt: 'Найди, где падает вставка из буфера',
    subagent_type: 'Explore'
  })
  toolResult(exploreCall, [{ type: 'text', text: 'Вставка падает в onPaste: пустой clipboardData.' }], {
    status: 'completed',
    agentId: EXPLORE_ID,
    agentType: 'Explore',
    prompt: 'Найди, где падает вставка из буфера',
    content: [{ type: 'text', text: 'Вставка падает в onPaste: пустой clipboardData.' }],
    totalTokens: 18000,
    totalDurationMs: 42000,
    totalToolUseCount: 7,
    usage: {
      input_tokens: 6,
      output_tokens: 410,
      cache_creation_input_tokens: 3100,
      cache_read_input_tokens: 14484,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: 3100, ephemeral_5m_input_tokens: 0 }
    }
  })

  // 3. Auto-compaction and the summary that replaces what came before.
  const beforeCompact = last
  add(
    {
      type: 'system',
      subtype: 'compact_boundary',
      logicalParentUuid: beforeCompact,
      content: 'Conversation compacted',
      level: 'info',
      compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 20000, durationMs: 61000 }
    },
    { parent: null }
  )
  user(
    'This session is being continued from a previous conversation that ran out of context. ' +
      'The summary below covers the earlier portion of the conversation.\n\n' +
      'Summary: the person asked why paste fails; an Explore agent found an empty clipboardData in onPaste.',
    { isVisibleInTranscriptOnly: true, isCompactSummary: true }
  )

  // 4. A background general-purpose subagent.
  user('теперь проверь тесты', { origin: { kind: 'human' }, promptSource: 'typed' })
  const testsCall = 'toolu_01TestsRun8bQf2Lx9Kd3Vw7'
  agentCall(testsCall, {
    description: 'Прогон тестов',
    prompt: 'Прогони тесты и расскажи, что упало',
    subagent_type: 'general-purpose',
    run_in_background: true
  })
  toolResult(testsCall, launchedText(TESTS_ID), launched(TESTS_ID, 'Прогон тестов'))

  // 5. A subagent of a type that does not exist.
  const buildCall = 'toolu_01BuildFail3Hs9Wq1Ne6Ty'
  agentCall(buildCall, {
    description: 'Сборка',
    prompt: 'Собери проект',
    subagent_type: 'builder'
  })
  toolResult(
    buildCall,
    "<tool_use_error>Agent type 'builder' not found. Available agents: general-purpose, Explore</tool_use_error>",
    "Error: Agent type 'builder' not found. Available agents: general-purpose, Explore",
    true
  )

  // 6. A background subagent that never reports back.
  const longCall = 'toolu_01LongReview5Gk2Pd8Xc4Ma'
  agentCall(longCall, {
    description: 'Долгий обзор',
    prompt: 'Посмотри весь модуль вставки',
    subagent_type: 'general-purpose',
    run_in_background: true
  })
  toolResult(longCall, launchedText(LONG_REVIEW_ID), launched(LONG_REVIEW_ID, 'Долгий обзор'))

  // 4, later: «Прогон тестов» reports back — queued mid-turn, then delivered.
  lines.push({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: stamp(),
    sessionId,
    content: NOTIFICATION
  })
  add({
    type: 'attachment',
    attachment: {
      type: 'queued_command',
      prompt: NOTIFICATION,
      commandMode: 'task-notification',
      timestamp: new Date(clock).toISOString()
    }
  })
  user(NOTIFICATION, {
    origin: { kind: 'task-notification' },
    promptSource: 'system',
    queueSkipAttachments: true
  })

  // 7. The last word, with the usage the panel should start from.
  assistant([{ type: 'text', text: 'жду подагентов' }], {
    input_tokens: 12,
    cache_creation_input_tokens: 1400,
    cache_read_input_tokens: 44022,
    output_tokens: 240
  })

  lines.push({
    type: 'cost-state',
    sessionId,
    totalCostUSD: 0.4182,
    totalAPIDuration: 98000,
    totalAPIDurationWithoutRetries: 98000,
    totalToolDuration: 152000,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalDuration: 240000,
    modelUsage: {},
    hasUnknownModelCost: false
  })

  return {
    lines,
    subagents: {
      [EXPLORE_ID]: subagentFile(EXPLORE_ID, exploreCall, 'Explore', 'Обзор вставки', [
        { type: 'tool_use', id: 'toolu_01ExploreRead7Lm3Bv', name: 'Read', input: { file_path: 'src/paste.ts' } },
        { type: 'text', text: 'Вставка падает в onPaste: пустой clipboardData.' }
      ]),
      [TESTS_ID]: subagentFile(TESTS_ID, testsCall, 'general-purpose', 'Прогон тестов', [
        { type: 'tool_use', id: 'toolu_01TestsBash2Kp8Zr', name: 'Bash', input: { command: 'npm test' } },
        { type: 'text', text: 'Упали два теста вставки.' }
      ]),
      [LONG_REVIEW_ID]: subagentFile(LONG_REVIEW_ID, longCall, 'general-purpose', 'Долгий обзор', [
        { type: 'text', text: 'Начинаю обзор модуля вставки.' }
      ])
    }
  }

  /**
   * A subagent's own file: its prompt, then each step; a tool step is
   * answered by a tool_result. Every line is a sidechain carrying agentId.
   */
  function subagentFile(agentId, toolUseId, agentType, description, steps) {
    let parent = null
    const own = []
    const push = (fields) => {
      const line = {
        parentUuid: parent,
        isSidechain: true,
        agentId,
        ...fields,
        uuid: uuid(),
        timestamp: stamp(),
        ...common()
      }
      own.push(line)
      parent = line.uuid
    }
    push({ type: 'user', message: { role: 'user', content: description } })
    for (const block of steps) {
      push({
        type: 'assistant',
        message: {
          model: 'claude-opus-5',
          type: 'message',
          role: 'assistant',
          content: [block],
          stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
          usage: { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000, output_tokens: 60 }
        }
      })
      if (block.type === 'tool_use') {
        push({
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: block.id, content: 'ok' }]
          }
        })
      }
    }
    return {
      meta: { agentType, description, toolUseId, spawnDepth: 1 },
      lines: own
    }
  }
}
