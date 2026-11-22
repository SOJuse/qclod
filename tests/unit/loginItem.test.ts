import { expect, test, vi } from 'vitest'
import { applyOpenAtLogin } from '../../src/main/system/loginItem'

const fake = (isPackaged: boolean) => ({
  isPackaged,
  setLoginItemSettings: vi.fn(),
  getLoginItemSettings: vi.fn()
})

test('в установленной сборке setLoginItemSettings({openAtLogin}) и ответ applied', () => {
  const app = fake(true)
  expect(applyOpenAtLogin(app as never, true)).toBe('applied')
  expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true })
  expect(applyOpenAtLogin(app as never, false)).toBe('applied')
  expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: false })
})

test('в dev ничего не регистрирует', () => {
  const app = fake(false)
  expect(applyOpenAtLogin(app as never, true)).toBe('dev')
  expect(app.setLoginItemSettings).not.toHaveBeenCalled()
})
