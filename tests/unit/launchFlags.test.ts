import { describe, expect, test } from 'vitest'
import { parseExtraFlags } from '../../src/main/agent/launchFlags'

describe('parseExtraFlags', () => {
  test('обычные флаги проходят', () => {
    expect(parseExtraFlags('--verbose')).toEqual({ args: { verbose: null }, rejected: [] })
    expect(parseExtraFlags('--fallback-model sonnet')).toEqual({
      args: { 'fallback-model': 'sonnet' },
      rejected: []
    })
    expect(parseExtraFlags('--fallback-model=sonnet')).toEqual({
      args: { 'fallback-model': 'sonnet' },
      rejected: []
    })
  })

  test('значение в кавычках остаётся одним', () => {
    expect(parseExtraFlags('--append-system-prompt "отвечай кратко"')).toEqual({
      args: { 'append-system-prompt': 'отвечай кратко' },
      rejected: []
    })
  })

  test('пусто и мусор не ломают разбор', () => {
    expect(parseExtraFlags(undefined)).toEqual({ args: {}, rejected: [] })
    expect(parseExtraFlags('')).toEqual({ args: {}, rejected: [] })
    expect(parseExtraFlags('просто слова')).toEqual({ args: {}, rejected: [] })
    expect(parseExtraFlags('--')).toEqual({ args: {}, rejected: [] })
  })

  test('флаг, выключающий разрешения, отклоняется', () => {
    // The box is for --verbose, not for a way around the permission gate.
    const result = parseExtraFlags('--dangerously-skip-permissions')
    expect(result.args).toEqual({})
    expect(result.rejected).toEqual(['--dangerously-skip-permissions'])
  })

  test('режим разрешений через флаг тоже отклоняется, в обеих записях', () => {
    expect(parseExtraFlags('--permission-mode bypassPermissions').args).toEqual({})
    expect(parseExtraFlags('--permission-mode=bypassPermissions').args).toEqual({})
    expect(parseExtraFlags('--PERMISSION-MODE=bypassPermissions').args).toEqual({})
  })

  test('подмена файла настроек и списков инструментов отклоняется', () => {
    for (const flag of [
      '--settings C:/чужие/settings.json',
      '--permission-prompt-tool мой-инструмент',
      '--allowedTools Bash',
      '--disallowed-tools Read',
      '--mcp-config C:/чужой/mcp.json',
      '--add-dir C:/',
      '--strict-mcp-config'
    ]) {
      const result = parseExtraFlags(flag)
      expect(result.args, flag).toEqual({})
      expect(result.rejected, flag).toHaveLength(1)
    }
  })

  test('значение отклонённого флага не остаётся сиротой', () => {
    // Otherwise "C:/чужие/settings.json" would be read as a flag of its own.
    const result = parseExtraFlags('--settings C:/чужие/settings.json --verbose')
    expect(result.args).toEqual({ verbose: null })
    expect(result.rejected).toEqual(['--settings'])
  })

  test('хорошие флаги рядом с плохими сохраняются', () => {
    const result = parseExtraFlags('--verbose --dangerously-skip-permissions --fallback-model opus')
    expect(result.args).toEqual({ verbose: null, 'fallback-model': 'opus' })
    expect(result.rejected).toEqual(['--dangerously-skip-permissions'])
  })
})

describe('parseExtraFlags: значение, похожее на флаг', () => {
  test('значение с дефисом отклоняется в обеих записях', () => {
    // Belt and braces: the SDK currently joins such a value into one argv
    // token, but a version that stops doing so would make this a real bypass.
    expect(parseExtraFlags('--foo=--dangerously-skip-permissions')).toEqual({
      args: {},
      rejected: ['--foo=--dangerously-skip-permissions']
    })
    // In the spaced form a dash-leading token is the next flag, not a value.
    expect(parseExtraFlags('--verbose --fallback-model opus').args).toEqual({
      verbose: null,
      'fallback-model': 'opus'
    })
  })

  test('отклонённое значение не превращается в отдельный флаг', () => {
    const result = parseExtraFlags('--foo=-x --verbose')
    expect(result.args).toEqual({ verbose: null })
  })

  test('обычное значение без дефиса по-прежнему проходит', () => {
    expect(parseExtraFlags('--fallback-model sonnet').args).toEqual({
      'fallback-model': 'sonnet'
    })
  })
})
