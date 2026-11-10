/**
 * Set by the bundler (electron.vite.config.ts, vitest.config.ts): true in the
 * e2e build, in `dev` and under vitest; false in the release build.
 *
 * Every test seam is read as `__QCLOD_TEST_SEAMS__ ? process.env['X'] : undefined`
 * right where it is used, so the release bundle loses the branch together with
 * the variable's name — `npm run check:seams` proves it on the built output.
 * Moving the read into a helper would keep the name alive.
 */
declare const __QCLOD_TEST_SEAMS__: boolean
