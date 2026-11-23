// The names of every test seam, as they would appear in a bundle. A release
// build must contain none of them (check-release-seams.mjs); the e2e build
// keeps them on purpose.
// The refusal text of a test build is listed too: it lives only in the branch
// that refuses the real agent, and must not reach a release. So is the error
// the renderer's pane-throw seam throws.
export const SEAM =
  /QCLOD_(FAKE_SDK|FAKE_ONESHOT|FAKE_HISTORY|FAKE_SHELL|PICK_FOLDER|PICK_FILES|CONFIRM_BYPASS|PREPARE_DELAY_MS|PREPARE_FAIL|ALLOW_REAL|FAKE_INSTALL|FAKE_AUTH|FAKE_UPDATE|FAKE_SLOW|FAKE_FAIL_TIMES|FAKE_FAIL|E2E_INVISIBLE|E2E_THROW_IN_PANE|HANG_MS|MOUNT_MS|FAKE_SPEECH_CRASH|FAKE_SPEECH|FAKE_MIC_ACCESS|FAKE_MIC|FAKE_NVIDIA|FAKE_VOICE_MANIFEST|VOICE_SELFTEST|RELAY_HOME|E2E_RELAY|E2E_SSH|RELAY_BINARY_DIR|E2E_TERMINAL|FAKE_VPN)|__qclodShellLog|__qclodAgentProxy|__qclodTelegramOpens|fake failure|__qclodRealAgentStarts|__qclodLoginOpens|__qclodUpdateRestarts|__qclodHasSession|fakeOneShot|__qclodVoiceStarts|__qclodVoiceSelftest|Тестовая сборка не запускает|e2e: render error in a pane|e2e: fake speech/g

/** Every part of the release build, relative to the project root: each is scanned. The relay (stage 6) too. */
export const RELEASE_DIRS = ['out/main', 'out/preload', 'out/renderer', 'out/relay']

/** The distinct seam names found in a piece of bundled code. */
export function seamsIn(code) {
  return [...new Set(code.match(SEAM) ?? [])]
}
