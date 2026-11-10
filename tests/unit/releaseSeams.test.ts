import { describe, expect, test } from 'vitest'
// @ts-expect-error plain .mjs helper shared with scripts/check-release-seams.mjs
import { seamsIn } from '../../scripts/releaseSeams.mjs'

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
      '__qclodShellLog',
      '__qclodRealAgentStarts',
      'Тестовая сборка не запускает'
    ]
    for (const name of names) expect(seamsIn(`x = process.env['${name}'];`)).toEqual([name])
  })

  test('обычный код лазейкой не считается', () => {
    expect(seamsIn('const userData = app.getPath("userData"); QCLOD_USER_DATA')).toEqual([])
  })
})
