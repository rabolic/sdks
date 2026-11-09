import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  platform: 'neutral',
  target: 'es2020',
  // The core is bundled in, as in @rabolic/web; React Native and AsyncStorage come from the app.
  alias: { '@rabolic/sdk-core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) },
  external: ['react-native', '@react-native-async-storage/async-storage'],
  dts: { resolve: ['@rabolic/sdk-core'] },
  fixedExtension: false,
  sourcemap: true,
  clean: true,
})
