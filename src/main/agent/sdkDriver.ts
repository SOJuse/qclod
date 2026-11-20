import type {
  query as queryFn,
  SDKControlGetUsageResponse
} from '@anthropic-ai/claude-agent-sdk'
import { importEsm } from '../esm'
import {
  sdkPermissionMode,
  type CommandInfo,
  type EffortLevel,
  type McpServerInfo,
  type LimitWindow,
  type ModelOption,
  type PanelData,
  type TaskOutput,
  type UserInput
} from '../../shared/types'
import { availabilityFrom, safeRemoteUrl, type RemoteAvailability } from '../../shared/remote'
import type { AgentDriver, ContextUsage, DriverOptions, RemoteLink } from './driver'
import { toPermissionContext } from './permissionContext'

type RemoteCapable = {
  enableRemoteControl?: (enabled: boolean, name?: string) => Promise<unknown>
}

/** How long to wait for the CLI's initialize answer before assuming nothing. */
const REMOTE_INIT_TIMEOUT_MS = 5000

type UsageWindow = NonNullable<SDKControlGetUsageResponse['rate_limits']>['five_hour']

/**
 * One window of the usage call, in the units `rate_limit_event` uses: there it
 * is 0–1 and unix seconds, here 0–100 and an ISO timestamp.
 */
function toLimitWindow(window: UsageWindow): LimitWindow | null {
  if (!window || window.utilization === null || window.resets_at === null) return null
  const resetsAt = Date.parse(window.resets_at)
  if (Number.isNaN(resetsAt)) return null
  return { utilization: window.utilization / 100, resetsAt: Math.floor(resetsAt / 1000) }
}

/**
 * One message, in the shape the SDK's streaming input expects.
 *
 * `input.text` goes as it is: the `@`-mentions of attached files are already in
 * it, put there once by `composeText` in `AgentSession.send`. Only images are
 * taken from the attachments here.
 *
 * Images go as real content blocks rather than as a path on disk: the SDK
 * accepts them directly, and v1's write-to-temp-file-then-@-mention dance was
 * both slower and one more thing to clean up (spec 6.3).
 */
function toSdkMessage(input: UserInput): Record<string, unknown> {
  const images = input.attachments.filter((a) => a.kind === 'image')

  const content: Array<Record<string, unknown>> = []
  if (input.text.trim() !== '') content.push({ type: 'text', text: input.text })
  for (const image of images) {
    if (image.kind !== 'image') continue
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 }
    })
  }

  return {
    type: 'user',
    message: { role: 'user', content: content.length > 0 ? content : '' },
    parent_tool_use_id: null,
    session_id: ''
  }
}

/**
 * The real session: the Agent SDK's `query()` in streaming-input mode.
 *
 * Streaming input is what makes one long-lived conversation possible — the
 * alternative, one `query()` per message, would start a new process per turn.
 * It also lets images go as attachments.
 *
 * Never exercised by the test suite: every automated run talks to the fixture
 * instead, by project constraint. Keep it thin enough to read.
 */
export async function createSdkDriver(options: DriverOptions): Promise<AgentDriver> {
  const { query } = await importEsm<{ query: typeof queryFn }>('@anthropic-ai/claude-agent-sdk')

  const inbox: Array<Record<string, unknown>> = []
  let wake: (() => void) | null = null
  let closed = false

  async function* prompt(): AsyncGenerator<never, void> {
    while (!closed) {
      if (inbox.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        if (closed) return
      }
      const next = inbox.shift()
      if (next) yield next as never
    }
  }

  const session = query({
    prompt: prompt(),
    options: {
      cwd: options.cwd,
      pathToClaudeCodeExecutable: options.executablePath,
      // The user's own CLI, not the one pinned inside the SDK package: it is
      // the build they are logged into and the one their settings fit.
      includePartialMessages: true,
      ...(options.model ? { model: options.model } : {}),
      ...(options.permissionMode
        ? { permissionMode: sdkPermissionMode(options.permissionMode) as 'default' }
        : {}),
      // Without it the CLI refuses bypassPermissions — at start and on every
      // later switch — and the refusal used to be swallowed, so «без проверок»
      // went on asking about everything. It only makes the mode reachable:
      // Qclod's own confirmation (AgentSession.allowMode) is the gate.
      allowDangerouslySkipPermissions: true,
      ...(options.resume ? { resume: options.resume } : {}),
      ...(options.extraArgs && Object.keys(options.extraArgs).length > 0
        ? { extraArgs: options.extraArgs }
        : {}),
      // Project settings load with no trust gate — the user's explicit choice,
      // recorded in spec §5 with its consequence.
      settingSources: ['user', 'project', 'local'],
      canUseTool: async (toolName, input, opts) => {
        const answer = await options.canUseTool(toolName, input, toPermissionContext(opts))
        // updatedInput is how an AskUserQuestion answer travels
        // (AskUserQuestionInput.answers in sdk-tools.d.ts).
        return answer.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: answer.updatedInput ?? input }
          : { behavior: 'deny', message: 'Отклонено в Qclod' }
      }
    }
  })

  // enableRemoteControl is in sdk.mjs but not in sdk.d.ts, so it is looked for.
  const remote = session as unknown as RemoteCapable

  function push(message: Record<string, unknown>): void {
    inbox.push(message)
    if (wake) {
      const resume = wake
      wake = null
      resume()
    }
  }

  return {
    messages: session as AsyncIterable<unknown>,

    send(input: UserInput): void {
      push(toSdkMessage(input))
    },

    // Temporary: the real logic comes with the queue tasks.
    async cancelQueued(): Promise<boolean | null> {
      return null
    },

    async interrupt(): Promise<undefined> {
      await session.interrupt()
      return undefined
    },

    async setPermissionMode(mode: string): Promise<void> {
      await session.setPermissionMode(sdkPermissionMode(mode) as 'default')
    },

    async supportedCommands(): Promise<CommandInfo[]> {
      const commands = await session.supportedCommands()
      return commands.map((c) => ({
        name: c.name,
        description: c.description ?? '',
        argumentHint: c.argumentHint ?? '',
        ...(c.aliases ? { aliases: c.aliases } : {}),
        ...(c.builtin === undefined ? {} : { builtin: c.builtin })
      }))
    },

    async mcpServerStatus(): Promise<McpServerInfo[]> {
      const servers = await session.mcpServerStatus()
      return servers.map((s) => ({ name: s.name, status: s.status as McpServerInfo['status'] }))
    },

    async getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<ContextUsage> {
      const usage = await session.getContextUsage(opts?.detail ? { detail: opts.detail } : undefined)
      return {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        ...(typeof usage.model === 'string' ? { model: usage.model } : {}),
        categories: usage.categories.map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind }))
      }
    },

    async supportedModels(): Promise<ModelOption[]> {
      const models = await session.supportedModels()
      return models.map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
        ...(m.supportedEffortLevels
          ? { supportedEffortLevels: m.supportedEffortLevels as ModelOption['supportedEffortLevels'] }
          : {})
      }))
    },

    async setModel(model: string): Promise<void> {
      await session.setModel(model)
    },

    async setEffort(level: EffortLevel): Promise<void> {
      // applyFlagSettings is session-scoped. The sibling that writes a settings
      // FILE is deliberately not used: the user's settings are never modified
      // (constraint 5).
      await session.applyFlagSettings({ effortLevel: level })
    },

    async planLimits(): Promise<PanelData['limits'] | null> {
      // Experimental in the SDK (sdk.d.ts) and absent from older builds, so it
      // is looked for rather than assumed. A CLI that cannot answer leaves the
      // limits to rate_limit_event, without a word in the ribbon.
      try {
        if (typeof session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') {
          return null
        }
        // skipBehaviors: only the plan's windows are wanted, not a scan of
        // every local transcript.
        const usage = await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
          skipBehaviors: true
        })
        if (usage.rate_limits_available === false || !usage.rate_limits) return null
        return {
          fiveHour: toLimitWindow(usage.rate_limits.five_hour),
          sevenDay: toLimitWindow(usage.rate_limits.seven_day)
        }
      } catch {
        return null
      }
    },

    async taskOutput(taskId: string): Promise<TaskOutput | null> {
      // getTaskOutput is in sdk.mjs but not on the Query type (sdk.d.ts
      // describes only its request and answer), so it is looked for. A CLI
      // that refuses — not a shell task, a redacting lane — reads as «no output».
      const read = (
        session as unknown as {
          getTaskOutput?: (
            id: string
          ) => Promise<{ output: string; total_bytes: number; truncated: boolean }>
        }
      ).getTaskOutput
      if (typeof read !== 'function') return null
      try {
        const answer = await read.call(session, taskId)
        if (!answer || typeof answer.output !== 'string') return null
        return {
          output: answer.output,
          totalBytes: typeof answer.total_bytes === 'number' ? answer.total_bytes : 0,
          truncated: answer.truncated === true
        }
      } catch {
        return null
      }
    },

    async stopTask(taskId: string): Promise<void> {
      await session.stopTask(taskId)
    },

    async remoteAvailability(): Promise<RemoteAvailability> {
      const hasMethod = typeof remote.enableRemoteControl === 'function'
      let timer: ReturnType<typeof setTimeout> | undefined
      let init: unknown
      try {
        init = await Promise.race([
          session.initializationResult(),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), REMOTE_INIT_TIMEOUT_MS)
          })
        ])
      } catch {
        init = undefined
      } finally {
        clearTimeout(timer)
      }
      return availabilityFrom(hasMethod, init)
    },

    async setRemoteControl(enabled: boolean, name?: string): Promise<RemoteLink | null> {
      const enable = remote.enableRemoteControl
      if (!enabled) {
        if (typeof enable !== 'function') return null
        await enable.call(session, false, name)
        return null
      }
      if (typeof enable !== 'function') throw new Error('enableRemoteControl отсутствует')
      const answer = (await enable.call(session, true, name)) as
        | { session_url?: unknown; connect_url?: unknown }
        | null
        | undefined
      const sessionUrl = safeRemoteUrl(answer?.session_url)
      if (!sessionUrl) throw new Error('CLI не вернул ссылку на сессию')
      const connectUrl = safeRemoteUrl(answer?.connect_url)
      return { sessionUrl, ...(connectUrl ? { connectUrl } : {}) }
    },

    async dispose(): Promise<void> {
      closed = true
      if (wake) {
        const resume = wake
        wake = null
        resume()
      }
      // close() ends the CLI process (sdk.d.ts); return() only stops reading
      // the stream and can leave the process behind.
      try {
        session.close()
      } catch {
        // Already gone.
      }
    }
  }
}
