import { describe, expect, test } from 'vitest'
import { detectMenu, stripAnsi } from '@renderer/terminal/menuDetect'

const ESC = String.fromCharCode(27)

describe('stripAnsi', () => {
  test('убирает SGR и перемещения курсора', () => {
    expect(stripAnsi(`${ESC}[38;2;255;193;7m❯ да${ESC}[m`)).toBe('❯ да')
    expect(stripAnsi(`${ESC}[15;2Hтекст`)).toBe('текст')
  })

  test('убирает OSC-последовательности со ссылками', () => {
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\ссылка`)).toBe('ссылка')
  })
})

describe('detectMenu', () => {
  test('строки с маркером выбора и пронумерованными вариантами дают true', () => {
    const lines = [
      'Do you want to make this edit to auth.ts?',
      '❯ 1. Yes',
      '  2. Yes, allow all edits',
      '  3. No, tell Claude what to do differently',
      'Enter to confirm · Esc to cancel'
    ]
    expect(detectMenu(lines)).toBe(true)
  })

  test('вопрос о доверии к папке распознаётся', () => {
    // Shape taken verbatim from the probe capture, 2026-11-07.
    const lines = [
      'Quick safety check: Is this a project you created or one you trust?',
      '❯ No, exit',
      '  Yes, I trust this folder',
      'Enter to confirm · Esc to cancel'
    ]
    expect(detectMenu(lines)).toBe(true)
  })

  test('ANSI-последовательности не мешают распознаванию', () => {
    const lines = [
      `${ESC}[38;2;255;193;7m❯ 1. Yes${ESC}[m`,
      `${ESC}[2m  2. No${ESC}[m`,
      `${ESC}[38;2;153;153;153mEnter to confirm · Esc to cancel${ESC}[m`
    ]
    expect(detectMenu(lines)).toBe(true)
  })

  test('обычный поток вывода даёт false', () => {
    const lines = [
      '⏺ Read(auth.ts)',
      '  Прочитано 120 строк',
      '⏺ Edit(auth.ts)',
      '  Внесено 3 правки'
    ]
    expect(detectMenu(lines)).toBe(false)
  })

  test('блок кода с цифрами в начале строк даёт false', () => {
    const lines = [
      '1. установить зависимости',
      '2. запустить сборку',
      '3. открыть приложение',
      'Готово.'
    ]
    expect(detectMenu(lines)).toBe(false)
  })

  test('подсказка про Enter без маркера выбора не считается меню', () => {
    expect(detectMenu(['Enter to confirm · Esc to cancel'])).toBe(false)
  })

  test('одинокий маркер без вариантов и подсказки не считается меню', () => {
    expect(detectMenu(['❯ просто строка приглашения'])).toBe(false)
  })

  test('пустой экран — не меню', () => {
    expect(detectMenu([])).toBe(false)
    expect(detectMenu(['', '   '])).toBe(false)
  })
})
