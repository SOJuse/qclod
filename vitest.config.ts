import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  // Unit tests exercise the seams, as the e2e build does (src/main/buildFlags.d.ts).
  define: { __QCLOD_TEST_SEAMS__: 'true' },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 20000
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  }
})
