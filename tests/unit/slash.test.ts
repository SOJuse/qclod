import { describe, expect, test } from 'vitest'
import {
  acceptCommand,
  commandItems,
  completeCommand,
  effortItems,
  bareLocalStep,
  findSlashQuery,
  modelItems,
  stepItems
} from '@renderer/input/slash'
import { markUnavailable, withLocalCommands } from '../../src/shared/commandFilter'
import type { CommandInfo, ModelOption } from '../../src/shared/types'

function cmd(name: string, extra: Partial<CommandInfo> = {}): CommandInfo {
  return { name, description: '', argumentHint: '', ...extra }
}

const MODELS: ModelOption[] = [
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

describe('findSlashQuery', () => {
  test('слеш в начале — запрос команды', () => expect(findSlashQuery('/com', 4)).toEqual({ query: 'com' }))
  test('один слеш — пустой запрос', () => expect(findSlashQuery('/', 1)).toEqual({ query: '' }))
  test('после пробела — уже аргумент, не запрос', () => expect(findSlashQuery('/model op', 9)).toBeNull())
  test('слеш в середине — не команда', () => expect(findSlashQuery('a/b', 3)).toBeNull())
  test('перевод строки до каретки — уже не команда', () => expect(findSlashQuery('/a\nb', 4)).toBeNull())
  test('каретка перед слешем — не запрос', () => expect(findSlashQuery('/com', 0)).toBeNull())
  test('запрос — только то, что до каретки', () =>
    expect(findSlashQuery('/compact', 3)).toEqual({ query: 'co' }))
})

describe('acceptCommand: что делает Enter', () => {
  test('локальная команда решается по имени, даже если у неё есть подсказка аргумента', () => {
    // The session sends `model` with `<model>`; it is still ours to answer.
    expect(acceptCommand(cmd('model', { argumentHint: '<model>' }))).toEqual({
      kind: 'step',
      step: { kind: 'model' },
      text: '/model '
    })
    expect(acceptCommand(cmd('effort', { argumentHint: '<level>' }))).toEqual({
      kind: 'step',
      step: { kind: 'effort' },
      text: '/effort '
    })
    expect(acceptCommand(cmd('resume'))).toEqual({ kind: 'history' })
  })

  test('команда с аргументом подставляется в поле и ждёт его', () => {
    expect(acceptCommand(cmd('rename', { argumentHint: '<название>' }))).toEqual({
      kind: 'fill',
      text: '/rename '
    })
  })

  test('обычная команда отправляется', () => {
    expect(acceptCommand(cmd('compact'))).toEqual({ kind: 'send', text: '/compact' })
  })

  test('недоступная команда ничего не делает', () => {
    const [rc] = markUnavailable([cmd('remote-control')])
    expect(acceptCommand(rc!)).toEqual({ kind: 'none' })
    expect(completeCommand(rc!)).toEqual({ kind: 'none' })
  })

  test('Tab дописывает команду, ничего не запуская', () => {
    expect(completeCommand(cmd('compact'))).toEqual({ kind: 'fill', text: '/compact ' })
    expect(completeCommand(cmd('model'))).toEqual({ kind: 'fill', text: '/model ' })
  })
})

describe('строки списка', () => {
  test('команда: имя со слешем, подсказка аргумента, описание; недоступная — с причиной', () => {
    const items = commandItems(
      withLocalCommands([
        cmd('compact', { description: 'Сжать контекст' }),
        cmd('rename', { description: 'Переименовать', argumentHint: '<название>' }),
        cmd('remote-control', { description: 'Удалённое управление' })
      ]),
      '',
      []
    )
    expect(items.find((i) => i.id === 'rename')).toMatchObject({
      primary: '/rename',
      hint: '<название>',
      secondary: 'Переименовать'
    })
    expect(items.find((i) => i.id === 'remote-control')?.disabledReason).toContain('терминале')
  })

  test('второй шаг /model — модели сессии, имя и описание', () => {
    expect(modelItems(MODELS, '')).toEqual([
      { id: 'claude-opus-5', primary: 'Opus 5', secondary: 'самая способная' },
      { id: 'claude-sonnet-5', primary: 'Sonnet 5', secondary: 'быстрее и дешевле' }
    ])
    expect(modelItems(MODELS, 'son').map((i) => i.id)).toEqual(['claude-sonnet-5'])
  })

  test('второй шаг до запуска сессии — одна недоступная строка, а не тупик', () => {
    for (const kind of ['model', 'effort'] as const) {
      const items = stepItems({ kind }, { models: MODELS, model: null, effort: null, started: false }, '')
      expect(items).toHaveLength(1)
      expect(items[0]?.disabledReason).toBe('Сессия ещё не запущена')
    }
  })

  test('сессия идёт, а моделей ещё нет — строка «загружается»', () => {
    const items = stepItems({ kind: 'model' }, { models: [], model: null, effort: null, started: true }, '')
    expect(items).toHaveLength(1)
    expect(items[0]?.disabledReason).toBe('Список моделей загружается…')
  })

  test('сессия идёт — второй шаг даёт настоящие значения', () => {
    const data = { models: MODELS, model: 'claude-sonnet-5', effort: null, started: true }
    expect(stepItems({ kind: 'model' }, data, '').map((i) => i.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5'
    ])
    expect(stepItems({ kind: 'effort' }, data, '')).toHaveLength(3)
  })

  test('/model и /effort без значения — свои, агенту не уходят', () => {
    expect(bareLocalStep('/model')).toEqual({ kind: 'model' })
    expect(bareLocalStep('  /effort  ')).toEqual({ kind: 'effort' })
    expect(bareLocalStep('/model opus')).toBeNull()
    expect(bareLocalStep('/compact')).toBeNull()
  })

  test('второй шаг /effort — уровни выбранной модели', () => {
    expect(effortItems(MODELS, 'claude-sonnet-5', '').map((i) => i.id)).toEqual(['low', 'medium', 'high'])
    expect(effortItems(MODELS, 'claude-opus-5', '')).toHaveLength(5)
    // A model the session did not describe offers every level.
    expect(effortItems([], null, '')).toHaveLength(5)
  })
})
