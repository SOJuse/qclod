import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Integration tests against real system tools: the ssh loop to a real sshd on
// the CI runner (stage 6). Never part of `npx vitest run`: they need a host
// (QCLOD_SSH_LOOP_HOST) and the relay's test binary (QCLOD_RELAY_BINARY_DIR).
export default defineConfig({
  define: { __QCLOD_TEST_SEAMS__: 'true' },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One sshd, one daemon: the steps run in order.
    fileParallelism: false
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  }
})
