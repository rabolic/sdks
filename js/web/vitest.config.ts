import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@rabolic/sdk-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  },
  test: {
    // Tests create their own happy-dom windows, so each starts from a clean page.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
