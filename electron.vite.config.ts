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
        rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      define,
      build: {
        rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
      }
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react()],
      build: {
        rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
      }
    }
  }
})
