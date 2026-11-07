import { query } from '@anthropic-ai/claude-agent-sdk'
import type { CommandInfo, McpServerInfo, UserInput } from '../../shared/types'
import type { AgentDriver, ContextUsage, DriverOptions } from './driver'

/** `@путь` with quotes when it contains spaces — the convention the probe confirmed. */
function mention(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

/**
 * One message, in the shape the SDK's streaming input expects.
 *
 * Images go as real content blocks rather than as a path on disk: the SDK
 * accepts them directly, and v1's write-to-temp-file-then-@-mention dance was
 * both slower and one more thing to clean up (spec 6.3).
 */
function toSdkMessage(input: UserInput): Record<string, unknown> {
  const files = input.attachments.filter((a) => a.kind === 'file')
  const images = input.attachments.filter((a) => a.kind === 'image')

  const text = [input.text, ...files.map((f) => mention(f.kind === 'file' ? f.path : ''))]
    .filter((part) => part.trim() !== '')
    .join('\n')

  const content: Array<Record<string, unknown>> = []
  if (text) content.push({ type: 'text', text })
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
export function createSdkDriver(options: DriverOptions): AgentDriver {
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
        ? { permissionMode: options.permissionMode as 'default' }
        : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      // Project settings load with no trust gate — the user's explicit choice,
      // recorded in spec §5 with its consequence.
      settingSources: ['user', 'project', 'local'],
      canUseTool: async (toolName, input, opts) => {
        const answer = await options.canUseTool(toolName, input as Record<string, unknown>, {
          ...(opts && typeof opts === 'object' && 'toolUseId' in opts
            ? { toolUseId: String((opts as { toolUseId?: unknown }).toolUseId ?? '') }
            : {})
        })
        return answer.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Отклонено в Qclod' }
      }
    }
  })

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

    async interrupt(): Promise<void> {
      await session.interrupt()
    },

    async setPermissionMode(mode: string): Promise<void> {
      await session.setPermissionMode(mode as 'default')
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

    async getContextUsage(): Promise<ContextUsage> {
      const usage = await session.getContextUsage()
      return {
        totalTokens: usage.totalTokens,
        maxTokens: usage.maxTokens,
        percentage: usage.percentage,
        categories: usage.categories.map((c) => ({ name: c.name, tokens: c.tokens, kind: c.kind }))
      }
    },

    async dispose(): Promise<void> {
      closed = true
      if (wake) {
        const resume = wake
        wake = null
        resume()
      }
      await session.return(undefined).catch(() => undefined)
    }
  }
}
