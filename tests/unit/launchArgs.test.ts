import { describe, expect, test } from 'vitest'
import { buildLaunchArgs, splitFlags } from '@main/sessions/launchArgs'
import { DEFAULT_SETTINGS } from '@main/store/settingsStore'

const SETTINGS_JSON = '{"hooks":{}}'

describe('splitFlags', () => {
  test('пустая строка даёт пустой список', () => {
    expect(splitFlags('')).toEqual([])
    expect(splitFlags('   ')).toEqual([])
  })

  test('разбивает по пробелам', () => {
    expect(splitFlags('--verbose --debug')).toEqual(['--verbose', '--debug'])
  })

  test('произвольная строка доп. флагов разбивается с учётом кавычек', () => {
    expect(splitFlags('--add-dir "C:\\Мои проекты\\apps" --verbose')).toEqual([
      '--add-dir',
      'C:\\Мои проекты\\apps',
      '--verbose'
    ])
  })

  test('одинарные кавычки тоже держат аргумент вместе', () => {
    expect(splitFlags("--msg 'hello world'")).toEqual(['--msg', 'hello world'])
  })
})

describe('buildLaunchArgs', () => {
  test('settings json всегда передаётся первым', () => {
    const args = buildLaunchArgs(DEFAULT_SETTINGS, {}, SETTINGS_JSON)
    expect(args.slice(0, 2)).toEqual(['--settings', SETTINGS_JSON])
  })

  test('пустые переопределения дают только глобальные флаги', () => {
    const settings = { ...DEFAULT_SETTINGS, defaults: { model: 'opus', permissionMode: 'plan' } }
    const args = buildLaunchArgs(settings, {}, SETTINGS_JSON)
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('opus')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
  })

  test('переопределения вкладки побеждают глобальные настройки', () => {
    const settings = { ...DEFAULT_SETTINGS, defaults: { model: 'opus', permissionMode: 'plan' } }
    const args = buildLaunchArgs(settings, { model: 'haiku' }, SETTINGS_JSON)
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
    // untouched keys still come from the global defaults
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(args.filter((a) => a === '--model')).toHaveLength(1)
  })

  test('не заданные флаги не попадают в командную строку', () => {
    const args = buildLaunchArgs(DEFAULT_SETTINGS, {}, SETTINGS_JSON)
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('--mcp-config')
  })

  test('пустая строка в переопределении считается "не задано"', () => {
    const settings = { ...DEFAULT_SETTINGS, defaults: { model: 'opus' } }
    const args = buildLaunchArgs(settings, { model: '  ' }, SETTINGS_JSON)
    expect(args[args.indexOf('--model') + 1]).toBe('opus')
  })

  test('доп. флаги вкладки идут после доп. флагов по умолчанию', () => {
    const settings = { ...DEFAULT_SETTINGS, defaults: { extraFlags: '--a' } }
    const args = buildLaunchArgs(settings, { extraFlags: '--b' }, SETTINGS_JSON)
    expect(args.indexOf('--a')).toBeGreaterThan(-1)
    expect(args.indexOf('--b')).toBeGreaterThan(args.indexOf('--a'))
  })
})
