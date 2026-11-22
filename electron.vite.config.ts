import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// Test seams (fake SDK, stubbed dialogs) exist in every build except the
// release one: `electron-vite build` runs in `production` mode, the e2e build
// is `electron-vite build --mode e2e`. See src/main/buildFlags.d.ts.
export default defineConfig(({ mode }) => {
  const define = { __QCLOD_TEST_SEAMS__: JSON.stringify(mode !== 'production') }
  return {
    main: {
      plugins: [externalizeDepsPlugin()],
      define,
      build: {
        // voiceWorker.js is the voice process (utilityProcess.fork in index.ts);
        // askpass.js: what the Mac's askpass.sh runs (src/main/ssh/askpassEntry.ts).
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/main/index.ts'),
            voiceWorker: resolve(__dirname, 'src/main/voice/worker.ts'),
            askpass: resolve(__dirname, 'src/main/ssh/askpassEntry.ts')

          }
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      define,
      build: {
        // Minified in a release, so its comments — which name the seams it
        // reads in the e2e build — do not ship (npm run check:seams).
        minify: mode === 'production',
        rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
      }
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react()],
      define,
      build: {
        // fallback.html is the page of a window that will not start: a second,
        // separate entry, so it does not depend on the bundle that failed.
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/renderer/index.html'),
            fallback: resolve(__dirname, 'src/renderer/fallback.html')
          }
        }
      }
    }
  }
})

