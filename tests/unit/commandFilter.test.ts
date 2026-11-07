import { describe, expect, test } from 'vitest'
import { filterCommands, markUnavailable } from '../../src/shared/commandFilter'
import type { CommandInfo } from '../../src/shared/types'

function cmd(name: string, extra: Partial<CommandInfo> = {}): CommandInfo {
  return { name, description: '', argumentHint: '', ...extra }
}

// The shape `supportedCommands()` really returns — 130 of these on the probe
// machine, builtin, user and plugin commands side by side.
const ALL: CommandInfo[] = [
  cmd('compact', { description: 'Сжать контекст', builtin: true }),
  cmd('clear', { description: 'Очистить разговор', builtin: true }),
  cmd('model', { description: 'Сменить модель', argumentHint: '<model>', builtin: true }),
  cmd('effort', { description: 'Сменить усилие', argumentHint: '<level>', builtin: true }),
  cmd('resume', { description: 'Открыть прошлую сессию', builtin: true }),
  cmd('my-command', { description: 'Команда пользователя' }),
  cmd('plugin:github:review', { description: 'Команда плагина' })
]

describe('filterCommands', () => {
  test('пустой запрос даёт недавние сверху, затем остальные', () => {
    const result = filterCommands(ALL, '', ['model', 'compact'])

    expect(result.slice(0, 2).map((c) => c.name)).toEqual(['model', 'compact'])
    expect(result).toHaveLength(ALL.length)
    // And nothing is lost or duplicated.
    expect(new Set(result.map((c) => c.name)).size).toBe(ALL.length)
  })

  test('сквозной поиск находит compact по cmp', () => {
    expect(filterCommands(ALL, 'cmp', [])[0]?.name).toBe('compact')
  })

  test('точное совпадение идёт выше частичного', () => {
    const result = filterCommands(ALL, 'model', [])
    expect(result[0]?.name).toBe('model')
  })

  test('команды плагинов и пользователя попадают в список наравне со встроенными', () => {
    // Two commands matching the same word rank by description; which of them
    // comes first is not the point — that neither is filtered out is.
    const found = filterCommands(ALL, 'команда', []).map((c) => c.name)
    expect(found).toHaveLength(2)
    expect(found).toContain('my-command')
    expect(found).toContain('plugin:github:review')

    expect(filterCommands(ALL, 'github', [])[0]?.name).toBe('plugin:github:review')
  })

  test('совпадение по имени сильнее совпадения по описанию', () => {
    const named = [cmd('contextual'), cmd('compact', { description: 'сжать contextual' })]
    expect(filterCommands(named, 'contextual', [])[0]?.name).toBe('contextual')
  })

  test('ничего не найдено — пустой список, а не весь', () => {
    expect(filterCommands(ALL, 'щщщ', [])).toEqual([])
  })

  test('недавняя команда, которой больше нет, не всплывает призраком', () => {
    const result = filterCommands(ALL, '', ['удалённая-команда', 'clear'])
    expect(result[0]?.name).toBe('clear')
    expect(result.map((c) => c.name)).not.toContain('удалённая-команда')
  })
})

describe('markUnavailable', () => {
  test('недоступная команда помечена и не выбирается', () => {
    // Remote Control needs the terminal Qclod no longer runs (spec 6.7).
    const marked = markUnavailable([...ALL, cmd('remote-control')])
    const rc = marked.find((c) => c.name === 'remote-control')

    expect(rc?.unavailableReason).toBeTruthy()
    expect(rc?.unavailableReason).toContain('Qclod')
    expect(marked.find((c) => c.name === 'compact')?.unavailableReason).toBeUndefined()
  })

  test('псевдонимы той же команды тоже помечаются', () => {
    const marked = markUnavailable([cmd('rc'), cmd('remote-control')])
    expect(marked.every((c) => c.unavailableReason)).toBe(true)
  })
})
