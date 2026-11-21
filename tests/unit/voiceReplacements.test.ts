import { describe, expect, test } from 'vitest'
import { applyReplacements, DEFAULT_REPLACEMENTS } from '@shared/voiceReplacements'

const apply = (t: string): string => applyReplacements(t, DEFAULT_REPLACEMENTS)

describe('словарь замен', () => {
  test('окончание съедается: «Попроси Клода» → «Попроси Claude»', () => {
    expect(apply('Попроси Клода')).toBe('Попроси Claude')
  })

  test('пробел и дефис внутри необязательны', () => {
    for (const v of ['тайп-скрипт', 'тайпскрипт', 'тайп скрипт', 'Тайп Скрипт']) {
      expect(apply(v), v).toBe('TypeScript')
    }
  })

  test('длинное раньше короткого: «гит пуш» → git push, «гидпуш» тоже', () => {
    expect(apply('сделай гидпуш')).toBe('сделай git push')
    expect(apply('гит пуш')).toBe('git push')
    expect(apply('гит хаб')).toBe('GitHub')
    expect(apply('закоммить в гит')).toBe('закоммить в git')
  })

  test('часть слова не меняется', () => {
    expect(apply('Клодин')).toBe('Клодин')
    expect(apply('гитара')).toBe('гитара')
  })

  test('регистр не важен', () => {
    expect(apply('КЛОД')).toBe('Claude')
    expect(apply('Джейсон и джисон')).toBe('JSON и JSON')
  })

  test('ё = е в записи и в тексте', () => {
    const entries = [{ from: 'ёж', to: 'hedgehog' }]
    expect(applyReplacements('Еж и ёж', entries)).toBe('hedgehog и hedgehog')
    expect(applyReplacements('ежа', [{ from: 'еж', to: 'X' }])).toBe('X')
    expect(applyReplacements('ёжа', [{ from: 'еж', to: 'X' }])).toBe('X')
  })

  test('спецсимволы в from не бросают и не трогают «c»', () => {
    const entries = [{ from: 'c++', to: 'C++' }]
    expect(() => applyReplacements('c и c++ и c', entries)).not.toThrow()
    expect(applyReplacements('c и c++ и c', entries)).toBe('c и C++ и c')
  })

  test('результат замены не заменяется повторно', () => {
    expect(applyReplacements('а', [{ from: 'а', to: 'б' }, { from: 'б', to: 'в' }])).toBe('б')
  })

  test('пустой список и пустая запись — без изменений', () => {
    expect(applyReplacements('Попроси Клода', [])).toBe('Попроси Клода')
    expect(applyReplacements('текст', [{ from: '  ', to: 'x' }])).toBe('текст')
  })

  test('текст Whisper не меняется', () => {
    expect(apply('Сделай git push')).toBe('Сделай git push')
  })

  test('другие записи стандартного словаря', () => {
    expect(apply('запусти эн пи эм и докер')).toBe('запусти npm и Docker')
    expect(apply('открой пулл реквест в реакте')).toBe('открой pull request в React')
    expect(apply('вс код и ви эс код')).toBe('VS Code и VS Code')
  })
})
