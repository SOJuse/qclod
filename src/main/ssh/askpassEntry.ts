/**
 * out/main/askpass.js: what the Mac's askpass.sh runs with
 * ELECTRON_RUN_AS_NODE=1 (decision 5) — no window, no Dock icon.
 * argv: [Qclod, askpass.js, question].
 */
import { runAskpassClient } from './askpassClient'

void runAskpassClient(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  () => process.exit(1)
)
