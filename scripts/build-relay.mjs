// Bundles the relay (src/relay/main.ts) into one CommonJS file for a Node 22
// single-executable binary: out/relay/relay.cjs, or with --e2e the test build
// out/relay-e2e/relay.cjs, which keeps its seams (QCLOD_RELAY_HOME, QCLOD_FAKE_SDK).
//
// The SDK is bundled in statically (probe 07: no esbuild warnings). It reads
// import.meta.url, which CommonJS has not: it is defined as the bundle's own
// file URL. minifySyntax drops the `if (false)` branches of a release build, so
// no seam name is left in it (npm run check:seams).
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const e2e = process.argv.includes('--e2e')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const outdir = join(root, e2e ? 'out/relay-e2e' : 'out/relay')
mkdirSync(outdir, { recursive: true })

const result = await build({
  entryPoints: [join(root, 'src/relay/main.ts')],
  outfile: join(outdir, 'relay.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minifySyntax: true,
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    __QCLOD_TEST_SEAMS__: JSON.stringify(e2e),
    __QCLOD_RELAY_VERSION__: JSON.stringify(version),
    'import.meta.url': '__qclodMetaUrl'
  },
  banner: { js: "const __qclodMetaUrl = require('url').pathToFileURL(__filename).href;" }
})
if (result.warnings.length > 0) console.warn(`esbuild: ${result.warnings.length} предупреждений`)
console.log(`${e2e ? 'out/relay-e2e' : 'out/relay'}/relay.cjs ${version}`)
