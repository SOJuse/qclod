import { describe, expect, test } from 'vitest'
import { remoteErrorText, stripAnsi } from '../../src/renderer/chat/stripAnsi'

describe('stripAnsi', () => {
  test('цвета, курсор, заголовок и ссылки уходят, текст остаётся', () => {
    expect(stripAnsi('\x1b[32m✓\x1b[0m готово')).toBe('✓ готово')
    expect(stripAnsi('\x1b[2K\x1b[1Gстрока')).toBe('строка')
    expect(stripAnsi('\x1b]0;title\x07после')).toBe('после')
    expect(stripAnsi('\x1b]8;;http://x\x1b\\ссылка\x1b]8;;\x1b\\')).toBe('ссылка')
    expect(stripAnsi('a\x1bMb')).toBe('ab')
  })

  test('обычный текст не меняется', () => {
    expect(stripAnsi('npm run dev -- --port 5173\n[ok]')).toBe('npm run dev -- --port 5173\n[ok]')
  })
})

describe('remoteErrorText', () => {
  test('снимает обёртку Electron', () => {
    expect(
      remoteErrorText(new Error("Error invoking remote method 'agent:taskStop': Error: задача уже закончилась"))
    ).toBe('задача уже закончилась')
    expect(remoteErrorText('просто текст')).toBe('просто текст')
  })
})
