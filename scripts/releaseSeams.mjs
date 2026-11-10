// The names of every test seam, as they would appear in a bundle. A release
// build must contain none of them (check-release-seams.mjs); the e2e build
// keeps them on purpose.
// The refusal text of a test build is listed too: it lives only in the branch
// that refuses the real agent, and must not reach a release.
export const SEAM =
  /QCLOD_(FAKE_SDK|FAKE_HISTORY|FAKE_SHELL|PICK_FOLDER|PICK_FILES|CONFIRM_BYPASS|PREPARE_DELAY_MS|PREPARE_FAIL|ALLOW_REAL|E2E_INVISIBLE)|__qclodShellLog|__qclodRealAgentStarts|Тестовая сборка не запускает/g

/** The distinct seam names found in a piece of bundled code. */
export function seamsIn(code) {
  return [...new Set(code.match(SEAM) ?? [])]
}
