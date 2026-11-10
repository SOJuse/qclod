import { describe, expect, test } from 'vitest'
import {
  filterCommands,
  isLocalCommand,
  markRemote,
  markUnavailable,
  withLocalCommands
} from '../../src/shared/commandFilter'
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
  test('remote-control больше не помечен недоступным', () => {
    expect(markUnavailable([cmd('remote-control'), cmd('rc')]).every((c) => !c.unavailableReason)).toBe(true)
  })
})

describe('Remote Control в списке', () => {
  test('remote-control есть в списке, даже если сессия его не прислала', () => {
    expect(withLocalCommands([]).find((c) => c.name === 'remote-control')).toMatchObject({ aliases: ['rc'] })
  })
  test('markRemote ставит причину блокировки', () => {
    expect(
      markRemote(withLocalCommands([]), 'нет подписки').find((c) => c.name === 'remote-control')?.unavailableReason
    ).toBe('нет подписки')
  })
  test('markRemote без блокировки ничего не трогает', () => {
    const list = withLocalCommands([])
    expect(markRemote(list, null)).toEqual(list)
  })
})

describe('команды, которые Qclod выполняет сам', () => {
  test('/resume помечен как открывающий историю, а не отправляемый агенту', () => {
    const marked = markUnavailable([cmd('resume', { description: 'Resume a conversation' })])

    expect(isLocalCommand('resume')).toBe(true)
    expect(marked[0]!.description).toBe('Открыть прошлый разговор')
    // Not «unavailable»: it works, just not by forwarding it.
    expect(marked[0]!.unavailableReason).toBeUndefined()
  })

  test('остальные команды уходят агенту как есть', () => {
    expect(isLocalCommand('compact')).toBe(false)
    expect(markUnavailable([cmd('compact', { description: 'Сжать контекст' })])[0]!.description).toBe(
      'Сжать контекст'
    )
  })
})

describe('withLocalCommands', () => {
  test('локальные команды есть, даже если сессия их не прислала', () => {
    expect(withLocalCommands([]).map((c) => c.name)).toEqual(
      expect.arrayContaining(['resume', 'model', 'effort'])
    )
  })

  test('присланную сессией команду не дублирует, а описание берёт своё', () => {
    const result = withLocalCommands([
      cmd('model', { description: 'Set the model', argumentHint: '<model>' }),
      cmd('remote-control')
    ])
    expect(result.filter((c) => c.name === 'model')).toHaveLength(1)
    // The session's own hint stays; the description is ours.
    expect(result.find((c) => c.name === 'model')?.argumentHint).toBe('<model>')
    expect(result.find((c) => c.name === 'model')?.description).not.toBe('Set the model')
    expect(result.find((c) => c.name === 'remote-control')?.unavailableReason).toBeUndefined()
  })
})
