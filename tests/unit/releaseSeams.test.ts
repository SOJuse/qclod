import { describe, expect, test } from 'vitest'
// @ts-expect-error plain .mjs helper shared with scripts/check-release-seams.mjs
import { RELEASE_DIRS, seamsIn } from '../../scripts/releaseSeams.mjs'

describe('проверка релизной сборки на тестовые лазейки', () => {
  test('находит каждую лазейку по имени, включая швы Task 19 и текст отказа тестовой сборки', () => {
    const names = [
      'QCLOD_FAKE_SDK',
      'QCLOD_FAKE_HISTORY',
      'QCLOD_FAKE_SHELL',
      'QCLOD_PICK_FOLDER',
      'QCLOD_PICK_FILES',
      'QCLOD_CONFIRM_BYPASS',
      'QCLOD_PREPARE_DELAY_MS',
      'QCLOD_PREPARE_FAIL',
      'QCLOD_ALLOW_REAL',
      'QCLOD_FAKE_INSTALL',
      'QCLOD_FAKE_AUTH',
      'QCLOD_FAKE_UPDATE',
      'QCLOD_FAKE_SLOW',
      'QCLOD_FAKE_FAIL',
      'QCLOD_FAKE_FAIL_TIMES',
      'QCLOD_E2E_INVISIBLE',
      'QCLOD_E2E_THROW_IN_PANE',
      'QCLOD_HANG_MS',
      '__qclodShellLog',
      '__qclodLoginOpens',
      '__qclodRealAgentStarts',
      '__qclodUpdateRestarts',
      '__qclodHasSession',
      'Тестовая сборка не запускает',
      // The renderer's pane-throw seam, by the error it throws.
      'e2e: render error in a pane'
    ]
    for (const name of names) expect(seamsIn(`x = process.env['${name}'];`)).toEqual([name])
  })

  test('обычный код лазейкой не считается', () => {
    expect(seamsIn('const userData = app.getPath("userData"); QCLOD_USER_DATA')).toEqual([])
  })

  test('проверяются все три части сборки: main, preload и renderer', () => {
    expect(RELEASE_DIRS).toEqual(['out/main', 'out/preload', 'out/renderer'])
  })
})
