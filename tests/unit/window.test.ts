import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, shell: {} }))

import { mainWindowOptions } from '../../src/main/window'
import { WINDOW_BG } from '../../src/shared/theme'
import { readTokens } from './cssTokens'

const css = readFileSync(resolve(__dirname, '../../src/renderer/styles/tokens.css'), 'utf8')

test('окно непрозрачное, фон — графит из токенов', () => {
  const o = mainWindowOptions()
  expect(o.backgroundMaterial).toBeUndefined()
  expect(o.transparent).not.toBe(true)
  expect(o.backgroundColor).toBe(WINDOW_BG)
  expect(readTokens(css).get('--bg')).toBe(WINDOW_BG)
})
