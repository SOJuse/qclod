import { expect, test } from 'vitest'
import { pickDefaultCwd } from '@main/tabs/defaultCwd'

test('собранное приложение не открывает вкладку в папке установки или System32', () => {
  expect(pickDefaultCwd(true, 'C:\\Windows\\System32', 'C:\\Users\\u')).toBe('C:\\Users\\u')
  expect(pickDefaultCwd(true, 'C:\\Users\\u\\AppData\\Local\\Programs\\Qclod', 'C:\\Users\\u')).toBe('C:\\Users\\u')
})
test('в разработке остаётся текущая папка', () => {
  expect(pickDefaultCwd(false, 'C:\\repo', 'C:\\Users\\u')).toBe('C:\\repo')
  expect(pickDefaultCwd(false, '', 'C:\\Users\\u')).toBe('C:\\Users\\u')
})
