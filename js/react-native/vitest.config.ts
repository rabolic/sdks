import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@rabolic/sdk-core': here('../core/src/index.ts'),
      // The real modules need a React Native runtime; tests pass a fake host instead.
      'react-native': here('test/fakes/react-native.ts'),
      '@react-native-async-storage/async-storage': here('test/fakes/async-storage.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
