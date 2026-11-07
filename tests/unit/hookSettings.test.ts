import { describe, expect, test } from 'vitest'
import { buildHookSettings, HOOK_EVENTS } from '@main/sessions/hookSettings'

const PIPE = '\\\\.\\pipe\\qclod-test'

interface HookCommand {
  type: string
  command: string
}
interface HookEntry {
  matcher?: string
  hooks: HookCommand[]
}
interface Settings {
  hooks: Record<string, HookEntry[]>
}

function parse(json: string): Settings {
  return JSON.parse(json) as Settings
}

describe('buildHookSettings', () => {
  test('содержит хуки Stop, Notification, PermissionRequest, SessionEnd', () => {
    const s = parse(buildHookSettings('tab-1', PIPE, undefined))
    for (const event of HOOK_EVENTS) {
      expect(Object.keys(s.hooks as object)).toContain(event)
    }
  })

  test('id вкладки попадает в команду хука', () => {
    const s = parse(buildHookSettings('tab-42', PIPE, undefined))
    const command = s.hooks['Stop'][0].hooks[0].command as string
    expect(command).toContain('tab-42')
    expect(command).toContain(PIPE)
  })

  test('Notification объявлен с матчерами ожидания ввода', () => {
    const s = parse(buildHookSettings('tab-1', PIPE, undefined))
    const matchers = s.hooks['Notification'].map((e) => e.matcher)
    expect(matchers).toContain('permission_prompt')
    expect(matchers).toContain('idle_prompt')
    expect(matchers).toContain('agent_needs_input')
  })

  test('существующие хуки пользователя сохранены рядом с нашими, а не затёрты', () => {
    const userHooks = {
      Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-bash' }] }]
    }
    const s = parse(buildHookSettings('tab-1', PIPE, userHooks))

    const stopCommands = s.hooks['Stop'].flatMap((e) =>
      e.hooks.map((h) => h.command)
    )
    expect(stopCommands).toContain('echo user-stop')
    expect(stopCommands.some((c: string) => c.includes('tab-1'))).toBe(true)

    // An event we do not use at all must survive untouched.
    expect(s.hooks['PreToolUse']).toEqual(userHooks.PreToolUse)
  })

  test('пользовательские настройки без секции hooks не ломают сборку JSON', () => {
    expect(() => buildHookSettings('tab-1', PIPE, undefined)).not.toThrow()
    expect(() => buildHookSettings('tab-1', PIPE, null)).not.toThrow()
    expect(() => buildHookSettings('tab-1', PIPE, 'garbage')).not.toThrow()
    expect(() => buildHookSettings('tab-1', PIPE, { Stop: 'not-an-array' })).not.toThrow()
  })

  test('мусор вместо пользовательских хуков отбрасывается, наши остаются', () => {
    const s = parse(buildHookSettings('tab-1', PIPE, { Stop: 'not-an-array' }))
    expect(Array.isArray(s.hooks['Stop'])).toBe(true)
    expect(s.hooks['Stop'][0].hooks[0].command).toContain('tab-1')
  })

  test('результат — валидный JSON одной строкой', () => {
    const json = buildHookSettings('tab-1', PIPE, undefined)
    expect(json).not.toContain('\n')
    expect(() => JSON.parse(json)).not.toThrow()
  })
})
