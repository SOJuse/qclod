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
      // stage 6: the relay's test build and the e2e ssh seams
      'QCLOD_RELAY_HOME',
      'QCLOD_E2E_RELAY',
      'QCLOD_E2E_SSH',
      'QCLOD_RELAY_BINARY_DIR',
      'QCLOD_E2E_TERMINAL',
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

  test('лазейки голоса: длинные имена целиком, а не по префиксу', () => {
    expect(
      seamsIn('QCLOD_FAKE_SPEECH QCLOD_FAKE_MIC_ACCESS QCLOD_FAKE_VOICE_MANIFEST __qclodVoiceSelftest e2e: fake speech').sort()
    ).toEqual(
      ['QCLOD_FAKE_SPEECH', 'QCLOD_FAKE_MIC_ACCESS', 'QCLOD_FAKE_VOICE_MANIFEST', '__qclodVoiceSelftest', 'e2e: fake speech'].sort()
    )
    for (const name of [
      'QCLOD_FAKE_SPEECH_CRASH',
      'QCLOD_FAKE_SPEECH',
      'QCLOD_FAKE_MIC_ACCESS',
      'QCLOD_FAKE_MIC',
      'QCLOD_FAKE_NVIDIA',
      'QCLOD_FAKE_VOICE_MANIFEST',
      'QCLOD_VOICE_SELFTEST',
      '__qclodVoiceStarts',
      '__qclodVoiceSelftest'
    ]) {
      expect(seamsIn(`x = process.env['${name}'];`)).toEqual([name])
    }
  })

  test('обычный код лазейкой не считается', () => {
    expect(seamsIn('const userData = app.getPath("userData"); QCLOD_USER_DATA')).toEqual([])
  })

  test('проверяются все части сборки: main, preload, renderer и посредник', () => {
    expect(RELEASE_DIRS).toEqual(['out/main', 'out/preload', 'out/renderer', 'out/relay'])
  })

  test('PATH-метка посредника и QCLOD_SSH_LOOP_HOST лазейками не считаются', () => {
    expect(seamsIn('const PATH_MARK = "__QCLOD_PATH__"; process.env.QCLOD_SSH_LOOP_HOST')).toEqual([])
  })
})
